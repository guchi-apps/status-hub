"use client"

import { useCallback, useEffect, useRef } from "react"
import { applyIncidentBadge } from "@/lib/incidents/badge-client"
import type { IncidentSnapshot } from "@/lib/incidents/types"

/**
 * PWAアイコンのバッジを、サーバーが定期処理で計算した未解消エラーの件数（`GET /api/incidents`）に
 * 合わせ続ける（#495）。画面には何も出さない（ヘッダーのボタンと一覧は#559で削除した）。
 */

const POLL_MS = 60_000

export function useIncidentBadgeSync(): void {
    const latestSeq = useRef(-1)

    const sync = useCallback(async () => {
        const res = await fetch("/api/incidents", { cache: "no-store" }).catch(() => null)
        if (!res?.ok) return
        const next = (await res.json()) as IncidentSnapshot
        // 遅れて返った古い応答で、件数を巻き戻さない
        if (next.seq < latestSeq.current) return
        latestSeq.current = next.seq
        void applyIncidentBadge(next)
    }, [])

    useEffect(() => {
        void sync()
        const timer = window.setInterval(() => void sync(), POLL_MS)
        // 閉じていた間の変化は、開き直した・前面に戻ったときにすぐ同期する
        const onVisible = () => {
            if (document.visibilityState === "visible") void sync()
        }
        document.addEventListener("visibilitychange", onVisible)
        window.addEventListener("online", onVisible)
        return () => {
            window.clearInterval(timer)
            document.removeEventListener("visibilitychange", onVisible)
            window.removeEventListener("online", onVisible)
        }
    }, [sync])
}
