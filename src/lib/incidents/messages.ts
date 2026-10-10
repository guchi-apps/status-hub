import type { PushMessage } from "@/lib/push/web-push"
import type { HostEvent } from "@/lib/incidents/types"

/** 通知をタップしたときに開く。ホストタブを出す */
export const INCIDENTS_URL = "/?tab=hosts"

export function formatJst(iso: string): string {
    const time = new Date(iso)
    if (Number.isNaN(time.getTime())) return iso
    return time.toLocaleString("ja-JP", {
        timeZone: "Asia/Tokyo",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    })
}

/**
 * ホストの出来事をPushの内容にする。受信が途絶えた原因（電源断・回線断・エージェント停止など）は
 * 区別できないため断定しない。再起動も、正常終了か異常終了かの根拠が無いので「再起動」とだけ書く。
 * `badge`・`seq` は送る時点の最新の件数と通番（再送でも古い件数を載せない）。
 */
export function buildHostMessage(
    event: HostEvent,
    latest: { count: number; seq: number }
): PushMessage {
    const times = `検知 ${formatJst(event.at)} / 最終受信 ${formatJst(event.lastReceivedAt)}`
    const common = { tag: `host-${event.hostId}`, url: INCIDENTS_URL, badge: latest.count, seq: latest.seq }

    switch (event.kind) {
        case "down":
            return {
                ...common,
                title: `${event.label}: 受信が途絶えました`,
                body: `停止の疑いがあります（電源・回線・エージェントのどれかは特定できません）。${times}`,
            }
        case "restart":
            return {
                ...common,
                title: `${event.label}: 再起動しました`,
                body: `稼働時間が巻き戻りました（正常終了か異常終了かは不明）。${times}`,
            }
        case "recovered":
            return {
                ...common,
                title: `${event.label}: 受信が再開しました`,
                body: `${event.rebooted ? "再起動後に" : ""}メトリクスの受信が戻りました。${times}`,
            }
    }
}

/** 設定画面の「テスト通知」。実際の障害ではないことが分かる文面にする */
export function buildTestMessage(latest: { count: number; seq: number }): PushMessage {
    return {
        title: "テスト通知",
        body: `ホスト停止・再起動の通知はこのように届きます。現在の未解消エラーは${latest.count}件です。`,
        tag: "host-test",
        url: INCIDENTS_URL,
        badge: latest.count,
        seq: latest.seq,
    }
}
