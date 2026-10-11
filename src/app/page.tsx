import { requireSessionForPage } from "@/lib/session"
import { isAideStatusConfigured } from "@/lib/aide-status"
import { DashboardDataProvider } from "@/components/dashboard-data"
import { DashboardShell } from "@/components/dashboard-shell"
import { fetchUptimeRobotMonitorsServer } from "@/lib/uptimerobot"
import { fetchUptimeKumaDashboardMonitors, getUptimeKumaAddMonitorUrl } from "@/lib/uptime-kuma"
import { isUptimeKumaAdminConfigured } from "@/lib/uptime-kuma-admin"

export const dynamic = "force-dynamic"

export default async function Home() {
    const session = await requireSessionForPage()

    // 初回描画で監視の枠が空にならないよう、サーバー側で取った値（取得失敗の理由を含む）を初期値として渡す
    const [uptimeKuma, uptimeRobot] = await Promise.all([
        fetchUptimeKumaDashboardMonitors(),
        fetchUptimeRobotMonitorsServer(),
    ])

    return (
        <DashboardDataProvider initial={{ uptimeKuma, uptimeRobot }}>
            <DashboardShell
                userEmail={session.user.email ?? ""}
                isAdmin={session.isAdmin}
                // モニター追加のURLと、画面から直接登録できるかの判定はサーバー側の
                // 環境変数から決まるため、ここで解決して渡す
                addMonitorUrl={getUptimeKumaAddMonitorUrl()}
                canAddMonitor={isUptimeKumaAdminConfigured()}
                aideConfigured={isAideStatusConfigured()}
            />
        </DashboardDataProvider>
    )
}
