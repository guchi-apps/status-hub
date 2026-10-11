/**
 * 未解消エラーとホスト障害の通知（#495）で共有する型。
 * クライアント（件数バッジ・一覧）からも読むため、Node専用のモジュールは読まない。
 */

/** 件数に数えるエラーの種類。各種類と既存判定の対応は docs/host-incident-alerts.md */
export type IncidentKind = "host-down" | "service" | "timer" | "sensor" | "monitor"

export interface Incident {
    /** 同一対象・同一原因を1件にまとめるキー（例: `host:sub-pc`、`monitor:kuma:12`） */
    key: string
    kind: IncidentKind
    title: string
    detail?: string
    /** この状態になったと判定した時刻（ISO）。同じキーが続く間は変えない */
    since: string
}

/** ホストの通知履歴。件数には入れず、復旧済みの再起動なども一覧の履歴に残す */
export type HostEventKind = "down" | "recovered" | "restart"

export interface HostEvent {
    id: string
    hostId: string
    label: string
    kind: HostEventKind
    /** 検知した時刻（ISO） */
    at: string
    /** 最後に受信した時刻（ISO） */
    lastReceivedAt: string
    /** 受信が途絶えたあとの復旧で、稼働時間の巻き戻り（再起動）も確認できたか */
    rebooted?: boolean
}

/** GET /api/incidents の応答。画面の件数・一覧・PWAバッジはすべてこの値から作る */
export interface IncidentSnapshot {
    /** 状態が変わるたびに増える通番。古いPushやレスポンスで件数が巻き戻るのを防ぐ */
    seq: number
    computedAt: string
    count: number
    incidents: Incident[]
    /** 取得できず、件数に反映できていない対象（正常とは扱わない） */
    unavailable: string[]
    /** 新しい順の通知履歴（直近のみ） */
    events: HostEvent[]
}

/** 受信が途絶えた・再起動したと判断してよい、稼働時間の巻き戻り幅（ミリ秒）の許容 */
export const RESTART_TOLERANCE_MS = 120_000
