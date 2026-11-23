/**
 * ホストの表示名を、受信したレポートの `label` ではなくホスト識別子から決める（#677）。
 *
 * 表示名はホスト側の `/etc/ops-dashboard-host-stats.env`（`HOST_STATS_LABEL`）が送ってくるが、
 * このファイルはroot所有でリポジトリのデプロイでは更新されない。#670 で例のenvだけを
 * 「DeskMini」へ直しても、稼働中のホストが「サブPC」を送り続けて画面が変わらなかった。
 * 識別子 `subpc`（本番が参照するため据え置き）の表示名はここで固定する。
 */
const DISPLAY_LABEL_BY_ID: Readonly<Record<string, string>> = {
    subpc: "DeskMini",
}

export function resolveHostLabel(id: string, reported: string | undefined | null, hostname: string): string {
    return DISPLAY_LABEL_BY_ID[id] ?? (reported || hostname)
}
