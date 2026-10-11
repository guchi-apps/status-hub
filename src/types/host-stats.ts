/** 使用量（メモリ・Swap・ディスク共通） */
export interface HostStatsUsage {
    usedBytes: number
    totalBytes: number
    usedPercent: number
}

export interface HostStatsDisk extends HostStatsUsage {
    path: string
}

export interface HostStatsService {
    name: string
    /** systemctl is-active の出力（active / inactive / failed など） */
    state: string
    active: boolean
}

/**
 * 定期ジョブ（systemd timer）1本分の状態。
 *
 * `services` の `systemctl is-active` では oneshot のジョブを扱えない。実行していない間は
 * ずっと `inactive` で、成功して終わったのか失敗して終わったのかを区別できないため、
 * タイマーと .service の両方から「最後にいつ動いて、どう終わったか」を集めて別に持つ（#75）。
 */
export interface HostStatsTimer {
    /** 設定に書かれたままの名前。ユーザー単位のユニットは `guchi@aide-zaim-sync` の形になる */
    name: string
    /** 実際に問い合わせた systemd ユニット名（`aide-zaim-sync.timer`） */
    unit: string
    /** ユーザー単位のユニットのときだけ入る、そのユーザー名 */
    user?: string
    /**
     * 状態を取得できたか。
     * false は「ジョブが壊れている」ではなく「エージェントから systemd に問い合わせられなかった」
     * ことを表す。取得できていないものを異常として鳴らすと誤検知になるため、両者を区別する。
     */
    available: boolean
    /** ユニットが存在するか（LoadState=loaded） */
    loaded?: boolean
    /** タイマーが起動しているか（ActiveState=active） */
    active?: boolean
    /** UnitFileState（enabled / disabled / static / masked など） */
    enabled?: string
    /** タイマーが最後に発火した時刻（ISO 8601） */
    lastTriggerAt?: string
    /** 次に発火する予定の時刻（ISO 8601）。予定を持たないタイマーでは undefined */
    nextElapseAt?: string
    /** 直近の実行結果（systemd の Result。success / exit-code / timeout など） */
    result?: string
    /** 直近の実行の終了ステータス */
    exitStatus?: number
    /** 直近の実行が終わった時刻（ISO 8601） */
    lastFinishedAt?: string
    /** いま実行中か。実行中は「予定を過ぎている」と数えない */
    running?: boolean
}

/**
 * センサー1台分の取得状況（#581）。
 *
 * ホストの死活とは別に「センサーの値が取れているか」を見るためのもの。Pi Zero W の SwitchBot 取得は
 * 一部のセンサーだけ見つからなくても終了コード0で終わる（部分成功）ため、定期ジョブの結果だけでは
 * 片方の停止に気づけない。取得スクリプトがセンサーごとに書き残した時刻をエージェントが送ってくる。
 */
export interface HostStatsSensor {
    /** センサーの表示名（取得側の設定の name） */
    name: string
    /** 最後に取得を試みた時刻（ISO 8601）。一度も試みていなければ undefined */
    lastAttemptAt?: string
    /** 最後に取得・送信まで成功した時刻（ISO 8601）。一度も成功していなければ undefined */
    lastSuccessAt?: string
    /** 直近の試行の結果（success / not_found / post_failed など、取得側が決める短い語） */
    lastResult?: string
}

/**
 * センサーの取得状況のまとまり。
 * `HOST_STATS_SENSOR_STATUS_FILE` を設定していないホストは項目ごと送ってこないため undefined。
 */
export interface HostStatsSensors {
    /**
     * 状態ファイルを読めたか。false は「センサーが止まっている」ではなく「取得側がまだ書いていない・
     * 読めなかった」ことを表す。0件を正常と取り違えないよう、空の一覧とは区別する。
     */
    available: boolean
    items: HostStatsSensor[]
}

/** 資源を食っている上位プロセス。CPU順とメモリ順で同じ形のものを別々に持つ */
export interface HostStatsProcess {
    name: string
    cpuPercent: number
    /** 常駐セットサイズ（RSS）。これを送らない世代のエージェントでは undefined */
    memoryBytes?: number
}

/** アプリ1つ分の資源。アプリの置き場（HOST_STATS_APPS_ROOT）直下のディレクトリが1アプリ */
export interface HostStatsApp {
    /** ディレクトリ名 */
    name: string
    /** 作業ディレクトリがこのアプリ配下にあるプロセスの PSS 合計（読めない環境では RSS で代用） */
    memoryBytes: number
    /** そのプロセス数。動いていないアプリは 0 */
    processes: number
    /** ディレクトリの使用量。まだ測っていない（キャッシュを置けない）ときは undefined */
    diskBytes?: number
}

/**
 * アプリ別のメモリ・ディスク使用量（#226）。
 * `HOST_STATS_APPS_ROOT` を設定していないホストや、これを送らない世代のエージェントでは undefined。
 */
export interface HostStatsApps {
    /** 集計したディレクトリ（例: /home/github-user/apps） */
    root: string
    items: HostStatsApp[]
    /** 置き場のファイルシステムの使用量。ディスク内訳の分母に使う */
    disk?: HostStatsUsage
    /** ディスク使用量を測った時刻（ISO 8601）。du は重いため1時間ごとにしか測らない */
    diskMeasuredAt?: string
}

/** 秒あたりの転送量。ネットワークとディスクI/Oで使う */
export interface HostStatsRate {
    inBytesPerSecond: number
    outBytesPerSecond: number
}

/** 運用上の気づき（再起動待ち・未適用の更新） */
export interface HostStatsMaintenance {
    rebootRequired: boolean
    /** 適用可能なパッケージ更新の件数。取得手段が無い環境では undefined */
    updatesAvailable?: number
    securityUpdatesAvailable?: number
}

export interface HostStatsSessions {
    /** ログイン中のセッション数 */
    count: number
    /** ログイン中のユーザー名（重複を除いたもの） */
    users: string[]
}

/**
 * tmux のセッション1つ分。
 *
 * サブPCは Claude Code のセッションを常駐させるホストで、リポジトリをまたいだ作業セッションが
 * 同じ `tmux ls` に並ぶ。いま何が動いているかが分からないと二重起動や放置に気づけないため、
 * ホストのメトリクスと一緒に送ってもらう。
 */
export interface HostStatsTmuxSession {
    name: string
    /** セッション内のウィンドウ数 */
    windows: number
    /** クライアントがアタッチしているか（放置セッションの見分けに使う） */
    attached: boolean
    /** セッションの作成時刻（ISO 8601） */
    createdAt?: string
    /** セッションの持ち主。ソケットの所有者から引く */
    user?: string
    /**
     * ペインで動いている、シェル以外のコマンド（重複を除いたもの）。
     * これを送らない世代のエージェントでは undefined になる。
     */
    commands?: string[]
    /**
     * シェル以外のコマンドが動いているか（＝作業中か）。
     * アタッチの有無では、デタッチしたまま裏で走っているセッションを見分けられないため別に持つ。
     * これを送らない世代のエージェントでは undefined になる。
     */
    busy?: boolean
    /** セッション内で最後に活動があった時刻（ISO 8601）。放置の判定に使う */
    lastActivityAt?: string
    /** アクティブなペインの作業ディレクトリ。ホームディレクトリは ~ に置き換えて送られる */
    path?: string
    /**
     * issue-deck の回収が「このセッションを畳まない」と判断した理由（#59）。
     * 付くのは回収の判定に乗ったセッションだけで、手で立てたセッションでは undefined。
     */
    holdReason?: string
    /**
     * その理由になった時刻（ISO 8601）。
     * **「最後に判定した時刻」ではない。** 回収は理由が変わったときだけ記録を書き直すため、
     * 同じ理由で止まっている期間が読める。回収自体が動いているかの判定には使えない。
     */
    holdReasonAt?: string
    /** Claude Code のフックが最後に記録したイベント名（Stop / permission_prompt など） */
    lastEventName?: string
    /** そのイベントの時刻（ISO 8601） */
    lastEventAt?: string
    /** セッションが対応するIssueのリポジトリ（owner/repo）。形式を満たさない値は落として送られない */
    issueRepository?: string
    /** セッションが対応するIssueの番号 */
    issueNumber?: number
}

/**
 * 各ホスト上のエージェント（scripts/host-stats/agent.sh）が送ってくる1回分のメトリクス。
 *
 * VPS・サブPCとも同じ経路（push型）に一本化しており、ダッシュボード自身が動いている
 * ホストであっても /proc を直接読むのではなく、このレポートを受け取って表示する。
 */
export interface HostStatsReport {
    /** ペイロード形式のバージョン。エージェントとダッシュボードの世代がずれたら弾く */
    version: number
    /** ホストの識別子。保存先のディレクトリ名になる。未指定ならホスト名から作る */
    id?: string
    /** 画面の見出しに使う表示名。未指定ならホスト名 */
    label?: string
    hostname: string
    os?: string
    kernel?: string
    /** エージェント側の収集時刻（ISO 8601）。時刻ずれの調査用で、鮮度判定には使わない */
    collectedAt?: string
    cpuPercent: number
    /** CPUの機種名（例: Apple M4）。これを送らない世代のエージェントでは undefined */
    cpuModel?: string
    /** 論理CPUの数（スレッド数）。これを送らない世代のエージェントでは undefined */
    cpuThreads?: number
    memory: HostStatsUsage
    swap?: HostStatsUsage
    disks: HostStatsDisk[]
    loadAverage: [number, number, number]
    uptimeSeconds: number
    temperatureCelsius?: number
    network?: HostStatsRate
    diskIo?: HostStatsRate
    topProcesses?: HostStatsProcess[]
    /**
     * メモリ使用量の多い順の上位プロセス。
     * メモリ枯渇でホストが止まる事故では、犯人がCPU順の一覧に出てこないため別に持つ。
     */
    topMemoryProcesses?: HostStatsProcess[]
    maintenance?: HostStatsMaintenance
    sessions?: HostStatsSessions
    /** tmux のセッション一覧。tmux が入っていないホストでは undefined（0件なら空配列） */
    tmuxSessions?: HostStatsTmuxSession[]
    /**
     * tmux セッションの総数。tmuxSessions は上限で切られるため、切り捨てた分を含む実数を別に持つ。
     * これを送らない世代のエージェントでは undefined。
     */
    tmuxSessionTotal?: number
    apps?: HostStatsApps
    services: HostStatsService[]
    /**
     * 定期ジョブ（systemd timer）の状態。
     * `HOST_STATS_TIMERS` を設定していないホストは項目ごと送ってこないため undefined になる。
     */
    timers?: HostStatsTimer[]
    /** センサーの取得状況（#581）。設定していないホストでは undefined */
    sensors?: HostStatsSensors
}

/** 保管済みの最新レポート。鮮度判定にはサーバー側で打った receivedAt を使う */
export interface HostStatsSnapshot extends HostStatsReport {
    id: string
    receivedAt: string
}

/** 履歴の1点。24時間分をJSONLで持つため、キー名は短くしている */
export interface HostStatsHistoryPoint {
    /** epoch 秒 */
    t: number
    cpu: number
    mem: number
    disk: number
    load: number
    swap?: number
    temp?: number
    /** ネットワーク受信・送信（バイト/秒） */
    rx?: number
    tx?: number
    /** ディスク読み込み・書き込み（バイト/秒） */
    ior?: number
    iow?: number
}

/**
 * センサー1台分の判定結果（#581）。判定は `src/lib/host-stats/sensors.ts` の `evaluateSensors`。
 * - ok: 閾値内に成功している
 * - retrying: 直近の1回は失敗したが、閾値内に成功がある（取りこぼしの範囲）
 * - stale: 閾値を超えて成功していない（取得停止）
 * - unknown: ホストが応答していない・記録が無いなど、判断できない
 */
export type HostSensorState = "ok" | "retrying" | "stale" | "unknown"

export interface HostSensorStatus {
    name: string
    state: HostSensorState
    /** 異常として数えるか。unknown は誤検知になるため数えない */
    abnormal: boolean
    /** 画面に出す1行（「取得 3分前」「取得停止（最終成功 2時間前）」など） */
    label: string
    /** 最後の成功からの経過秒数。成功の記録が無ければ undefined */
    successAgeSeconds?: number
    lastResult?: string
}

export interface HostSensorsView {
    /** 状態ファイルを読めたか（`HostStatsSensors.available`） */
    available: boolean
    /** 取得停止とみなす閾値（秒）。画面の注記に使う */
    staleAfterSeconds: number
    items: HostSensorStatus[]
}

/** 1ホスト分の表示データ */
export interface HostStatsHostView {
    id: string
    label: string
    latest: HostStatsSnapshot
    /** 最終受信からの経過秒数 */
    ageSeconds: number
    online: boolean
    history: HostStatsHistoryPoint[]
    /** センサーの取得状況の判定。センサーを送ってこないホストでは undefined */
    sensors?: HostSensorsView
}

/** GET /api/host-stats のレスポンス */
export interface HostStatsView {
    /** 一度も受信していないホストは含まれない（空ならセクションごと非表示） */
    hosts: HostStatsHostView[]
    offlineAfterSeconds: number
    historyHours: number
}
