"use client"

import { CSRF_HEADERS } from "@/lib/csrf-headers"
import { Bell, BellOff, ChevronRight, X } from "lucide-react"
import { useCallback, useEffect, useId, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { MENU_ITEM_CLASS, useHeaderMenu } from "@/components/header-menu"
import { Button } from "@/components/ui/button"
import type { LoginAlertsMode } from "@/lib/push/web-push"
import { cn } from "@/lib/utils"

/**
 * ヘッダーメニュー内の「通知」の行（#263・#268）。AI利用枠が上限に近づいたときのプッシュ通知を、この端末で受け取るかを切り替える。
 *
 * 行を押すとメニューを閉じて、設定を全画面のモーダルで開く（#503。メニューの幅では見切れるため）。判定と送信はサーバー側（`src/lib/ai-usage/alerts.ts`）で、ここがするのは端末の登録だけ。
 * 通知の許可はボタン操作の中でしか求められない（特にiOS）ため、「通知をオンにする」を押したときに許可を求める。
 * サーバーに鍵が無ければ行ごと出さない。
 *
 * メニューを閉じている間もマウントされたままなので、下の初期化はメニューを開かなくても走る。
 */

/**
 * unsupported — このブラウザでは受け取れない（iPhoneのSafariのタブなど）
 * default     — まだ許可を求めていない
 * granted     — この端末へ届く
 * denied      — 以前「許可しない」を選んだ
 */
type NotifyState = "unsupported" | "default" | "granted" | "denied"

/** 行の右に出す、この端末の状態 */
const STATE_LABELS: Record<NotifyState, string> = {
    granted: "オン",
    default: "オフ",
    denied: "ブロック中",
    unsupported: "非対応",
}

const SERVICE_WORKER_PATH = "/sw.js"

function isPushSupported(): boolean {
    return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window
}

/** iPhone・iPadのSafari。ホーム画面に追加したアプリからでないと通知を受け取れない */
function isIosBrowserTab(): boolean {
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
    const standalone =
        window.matchMedia("(display-mode: standalone)").matches ||
        (navigator as Navigator & { standalone?: boolean }).standalone === true
    return ios && !standalone
}

/** VAPIDの公開鍵（base64url）を購読に渡す形へ */
function toApplicationServerKey(base64Url: string): Uint8Array<ArrayBuffer> {
    const padding = "=".repeat((4 - (base64Url.length % 4)) % 4)
    const binary = window.atob((base64Url + padding).replace(/-/g, "+").replace(/_/g, "/"))
    const bytes = new Uint8Array(new ArrayBuffer(binary.length))
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    return bytes
}

async function postSubscription(
    subscription: PushSubscription,
    confirm: boolean,
    extra: { hostAlerts?: boolean; loginAlerts?: LoginAlertsMode; test?: boolean } = {}
): Promise<{ ok: boolean; delivered?: boolean }> {
    const res = await fetch("/api/push-subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...CSRF_HEADERS },
        body: JSON.stringify({ subscription: subscription.toJSON(), confirm, ...extra }),
    })
    const body = res.ok ? ((await res.json().catch(() => ({}))) as { delivered?: boolean }) : {}
    return { ok: res.ok, delivered: body.delivered }
}

/** この端末の、ホスト・監視の通知がオンか。サーバーに記録が無い・取れないときは null */
async function fetchHostAlerts(subscription: PushSubscription): Promise<boolean | null> {
    const url = `/api/push-subscriptions?endpoint=${encodeURIComponent(subscription.endpoint)}`
    const res = await fetch(url, { cache: "no-store" }).catch(() => null)
    if (!res?.ok) return null
    return ((await res.json()) as { hostAlerts?: boolean | null }).hostAlerts ?? null
}

/** この端末のログイン通知の設定。サーバーに記録が無い・取れないときは null */
async function fetchLoginAlerts(subscription: PushSubscription): Promise<LoginAlertsMode | null> {
    const url = `/api/push-subscriptions?endpoint=${encodeURIComponent(subscription.endpoint)}`
    const res = await fetch(url, { cache: "no-store" }).catch(() => null)
    if (!res?.ok) return null
    return ((await res.json()) as { loginAlerts?: LoginAlertsMode | null }).loginAlerts ?? null
}

const LOGIN_ALERTS_OPTIONS: { value: LoginAlertsMode; label: string }[] = [
    { value: "new", label: "新しい接続元のみ" },
    { value: "always", label: "毎回" },
    { value: "off", label: "オフ" },
]

async function subscribe(publicKey: string): Promise<PushSubscription> {
    const registration = await navigator.serviceWorker.ready
    const existing = await registration.pushManager.getSubscription()
    if (existing) return existing

    return registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: toApplicationServerKey(publicKey),
    })
}

export function UsageNotifications({ isAdmin = false }: { isAdmin?: boolean }) {
    const [publicKey, setPublicKey] = useState<string | null>(null)
    const [state, setState] = useState<NotifyState>("default")
    const [iosTab, setIosTab] = useState(false)
    const [open, setOpen] = useState(false)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [hostAlerts, setHostAlerts] = useState<boolean | null>(null)
    const [loginAlerts, setLoginAlerts] = useState<LoginAlertsMode | null>(null)
    const [testResult, setTestResult] = useState<string | null>(null)
    const menu = useHeaderMenu()

    // 鍵の有無を確かめ、Service Workerを登録する。すでに許可済みの端末は、サーバー側の記録が
    // 消えていても届くよう、起動のたびに購読を登録し直す（確認の通知は送らない）
    useEffect(() => {
        let cancelled = false

        const init = async () => {
            const res = await fetch("/api/push-subscriptions", { cache: "no-store" }).catch(() => null)
            const key = res?.ok ? ((await res.json()) as { publicKey: string | null }).publicKey : null
            if (cancelled || !key) return

            if (!isPushSupported()) {
                setIosTab(isIosBrowserTab())
                setState("unsupported")
                setPublicKey(key)
                return
            }

            await navigator.serviceWorker.register(SERVICE_WORKER_PATH)
            const permission = Notification.permission
            if (permission === "granted") {
                const subscription = await subscribe(key)
                await postSubscription(subscription, false)
                setHostAlerts(await fetchHostAlerts(subscription))
                setLoginAlerts(await fetchLoginAlerts(subscription))
            }
            if (cancelled) return

            setState(permission)
            setPublicKey(key)
        }

        init().catch((reason) => console.error("通知の準備に失敗しました:", reason))
        return () => {
            cancelled = true
        }
    }, [])

    const enable = useCallback(async () => {
        if (!publicKey) return
        setBusy(true)
        setError(null)
        try {
            const permission = await Notification.requestPermission()
            setState(permission)
            if (permission !== "granted") return

            const subscription = await subscribe(publicKey)
            if (!(await postSubscription(subscription, true)).ok) {
                setError("サーバーへの登録に失敗しました。時間をおいてもう一度押してください。")
                return
            }
            setHostAlerts(true)
        } catch (reason) {
            console.error("通知をオンにできませんでした:", reason)
            setError("通知をオンにできませんでした。時間をおいてもう一度押してください。")
        } finally {
            setBusy(false)
        }
    }, [publicKey])

    const toggleHostAlerts = useCallback(async () => {
        setBusy(true)
        setError(null)
        setTestResult(null)
        try {
            const registration = await navigator.serviceWorker.ready
            const subscription = await registration.pushManager.getSubscription()
            if (!subscription) return
            const next = hostAlerts === false
            if (!(await postSubscription(subscription, false, { hostAlerts: next })).ok) {
                setError("設定を保存できませんでした。時間をおいてもう一度押してください。")
                return
            }
            setHostAlerts(next)
        } catch (reason) {
            console.error("ホスト通知の設定を変えられませんでした:", reason)
            setError("設定を保存できませんでした。")
        } finally {
            setBusy(false)
        }
    }, [hostAlerts])

    const changeLoginAlerts = useCallback(async (next: LoginAlertsMode) => {
        setBusy(true)
        setError(null)
        try {
            const registration = await navigator.serviceWorker.ready
            const subscription = await registration.pushManager.getSubscription()
            if (!subscription) return
            if (!(await postSubscription(subscription, false, { loginAlerts: next })).ok) {
                setError("設定を保存できませんでした。時間をおいてもう一度押してください。")
                return
            }
            setLoginAlerts(next)
        } catch (reason) {
            console.error("ログイン通知の設定を変えられませんでした:", reason)
            setError("設定を保存できませんでした。")
        } finally {
            setBusy(false)
        }
    }, [])

    const sendTest = useCallback(async () => {
        setBusy(true)
        setError(null)
        setTestResult(null)
        try {
            const registration = await navigator.serviceWorker.ready
            const subscription = await registration.pushManager.getSubscription()
            if (!subscription) return
            const result = await postSubscription(subscription, false, { test: true })
            setTestResult(
                !result.ok
                    ? "テスト通知を送れませんでした。"
                    : result.delivered
                      ? "テスト通知を送りました。数秒で届きます。"
                      : "テスト通知が配信されませんでした。端末の通知設定を確認してください。"
            )
        } catch (reason) {
            console.error("テスト通知を送れませんでした:", reason)
            setError("テスト通知を送れませんでした。")
        } finally {
            setBusy(false)
        }
    }, [])

    const focusMenuButton = menu?.focusMenuButton
    const closeModal = useCallback(() => {
        setOpen(false)
        focusMenuButton?.()
    }, [focusMenuButton])

    const disable = useCallback(async () => {
        setBusy(true)
        setError(null)
        try {
            const registration = await navigator.serviceWorker.ready
            const subscription = await registration.pushManager.getSubscription()
            if (subscription) {
                await fetch("/api/push-subscriptions", {
                    method: "DELETE",
                    headers: { "Content-Type": "application/json", ...CSRF_HEADERS },
                    body: JSON.stringify({ endpoint: subscription.endpoint }),
                })
                await subscription.unsubscribe()
            }
            // 許可そのものはページから取り消せないため、次に押したときは確認なしで登録し直す
            setState("default")
        } catch (reason) {
            console.error("通知をオフにできませんでした:", reason)
            setError("通知をオフにできませんでした。")
        } finally {
            setBusy(false)
        }
    }, [])

    if (!publicKey) return null

    const enabled = state === "granted"
    const Icon = enabled ? Bell : BellOff
    const stateLabel = STATE_LABELS[state]

    return (
        <div className="mt-1 border-t border-border pt-1">
            <button
                type="button"
                onClick={() => {
                    menu?.closeMenu()
                    setOpen(true)
                }}
                aria-haspopup="dialog"
                className={MENU_ITEM_CLASS}
            >
                <Icon
                    className={cn("size-3.5", enabled ? "text-primary" : "text-muted-foreground")}
                    aria-hidden
                />
                <span className="flex-1">通知</span>
                <span
                    className={cn(
                        "rounded-full px-2 py-px text-[11px] font-bold",
                        enabled ? "bg-primary/10 text-primary" : "font-normal text-muted-foreground"
                    )}
                >
                    {stateLabel}
                </span>
                <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden />
            </button>

            {open && (
                <NotificationSettingsModal
                    stateLabel={stateLabel}
                    enabled={enabled}
                    onClose={closeModal}
                >
{state === "granted" && (
                <>
                    <p className="font-bold">通知は有効です</p>
                    <NotifyConditions />
                    <p className="text-muted-foreground">アプリを閉じていても届きます。</p>
                    <div className="flex items-center gap-2 rounded-md border border-border p-2">
                        <span className="flex-1">
                            <span className="font-bold">ホスト・監視の障害通知</span>
                            <span className="ml-1.5 text-muted-foreground">
                                {hostAlerts === false ? "オフ" : "オン"}
                            </span>
                        </span>
                        <Button variant="outline" size="sm" type="button" onClick={toggleHostAlerts} disabled={busy}>
                            {hostAlerts === false ? "オンにする" : "オフにする"}
                        </Button>
                    </div>
                    {isAdmin && (
                        <div className="flex flex-col gap-1.5 rounded-md border border-border p-2">
                            <span>
                                <span className="font-bold">ログイン通知</span>
                                <span className="ml-1.5 text-muted-foreground">管理者の端末だけに届きます</span>
                            </span>
                            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="ログイン通知">
                                {LOGIN_ALERTS_OPTIONS.map((option) => (
                                    <Button
                                        key={option.value}
                                        variant={(loginAlerts ?? "new") === option.value ? "default" : "outline"}
                                        size="sm"
                                        type="button"
                                        role="radio"
                                        aria-checked={(loginAlerts ?? "new") === option.value}
                                        onClick={() => changeLoginAlerts(option.value)}
                                        disabled={busy}
                                    >
                                        {option.label}
                                    </Button>
                                ))}
                            </div>
                        </div>
                    )}
                    <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                        <Button variant="outline" size="sm" type="button" className="h-11 sm:h-8" onClick={sendTest} disabled={busy}>
                            テスト通知
                        </Button>
                        <Button variant="outline" size="sm" type="button" className="h-11 sm:h-8" onClick={disable} disabled={busy}>
                            この端末への通知を止める
                        </Button>
                    </div>
                </>
            )}
            {state === "default" && (
                <>
                    <p className="font-bold">通知をオンにしますか？</p>
                    <NotifyConditions />
                    <p className="text-muted-foreground">
                        アプリを閉じていてもこの端末へ通知します。次に出る確認で「許可」を選んでください。
                    </p>
                    <div className="flex flex-col sm:flex-row sm:justify-end">
                        <Button size="sm" type="button" className="h-11 sm:h-8" onClick={enable} disabled={busy}>
                            {busy ? "設定中…" : "通知をオンにする"}
                        </Button>
                    </div>
                </>
            )}
            {state === "denied" && (
                <>
                    <p className="font-bold">通知がブロックされています</p>
                    <p className="text-muted-foreground">
                        以前「許可しない」を選んだため、ここからは許可を求められません。端末（またはブラウザ）の設定で、このサイトの通知を許可してから開き直してください。
                    </p>
                </>
            )}
            {state === "unsupported" && (
                <>
                    <p className="font-bold">この開き方では通知を受け取れません</p>
                    <p className="text-muted-foreground">
                        {iosTab
                            ? "iPhone・iPadでは、共有メニューの「ホーム画面に追加」から追加したアプリで開くと使えます。"
                            : "このブラウザはプッシュ通知に対応していません。"}
                    </p>
                </>
            )}
            {testResult && <p className="text-muted-foreground">{testResult}</p>}
            {state !== "unsupported" && state !== "denied" && <BadgeNotes />}
            {error && <p className="text-destructive">{error}</p>}
                </NotificationSettingsModal>
            )}
        </div>
    )
}

/**
 * 通知設定のモーダル（#503）。スマホ幅は全画面、sm以上は中央のダイアログ。
 * メニューのパネルは transform を持つ祖先の中にあり `fixed` が画面基準にならないため、body 直下へ portal で出す。
 * 閉じたときのフォーカスは、非表示になった「通知」行ではなく呼び出し側（メニューボタン）へ戻す。
 */
function NotificationSettingsModal({
    stateLabel,
    enabled,
    onClose,
    children,
}: {
    stateLabel: string
    enabled: boolean
    onClose: () => void
    children: React.ReactNode
}) {
    const closeRef = useRef<HTMLButtonElement>(null)
    const titleId = useId()

    useEffect(() => {
        const previousOverflow = document.body.style.overflow
        document.body.style.overflow = "hidden"
        closeRef.current?.focus()

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose()
        }
        document.addEventListener("keydown", onKeyDown)
        return () => {
            document.removeEventListener("keydown", onKeyDown)
            document.body.style.overflow = previousOverflow
        }
    }, [onClose])

    return createPortal(
        <div className="fixed inset-0 z-[60] bg-black/60 sm:flex sm:items-center sm:justify-center sm:p-5" onClick={onClose}>
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                onClick={(event) => event.stopPropagation()}
                className="flex h-dvh w-full flex-col bg-popover text-popover-foreground sm:h-auto sm:max-h-[min(86dvh,760px)] sm:max-w-[520px] sm:rounded-2xl sm:border sm:border-border sm:shadow-2xl"
            >
                <div className="flex shrink-0 items-center gap-2.5 border-b border-border px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
                    <h2 id={titleId} className="flex-1 text-base font-bold">
                        通知
                    </h2>
                    <span
                        className={cn(
                            "rounded-full px-2 py-px text-[11px] font-bold",
                            enabled ? "bg-primary/10 text-primary" : "font-normal text-muted-foreground"
                        )}
                    >
                        {stateLabel}
                    </span>
                    <button
                        ref={closeRef}
                        type="button"
                        onClick={onClose}
                        aria-label="閉じる"
                        className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
                    >
                        <X className="size-4" aria-hidden />
                    </button>
                </div>
                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 text-sm">
                    {children}
                </div>
            </div>
        </div>,
        document.body
    )
}

function BadgeNotes() {
    return (
        <p className="text-muted-foreground">
            ホーム画面のアイコンには、未解消エラーの件数を表示します（iOS 16.4以降のホーム画面に追加したアプリ）。
            通知やバッジは端末の設定でオフにされていると出ません。その場合も、画面右上のボタンから件数と一覧を確認できます。
        </p>
    )
}

function NotifyConditions() {
    return (
        <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
            <li>ホストの受信が5分途絶えた・再開した・再起動した</li>
            <li>Claude 5時間枠が90%以上</li>
            <li>週間枠（Claude・ChatGPT）が95%以上</li>
            <li>上記の枠が100%に到達</li>
        </ul>
    )
}
