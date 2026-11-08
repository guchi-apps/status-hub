export type AiProviderId = "claude" | "chatgpt" | "typesafe"

/**
 * ok           — 使用状況を取得できた
 * unconfigured — 認証情報が未設定
 * error        — 設定はあるが取得に失敗した
 */
export type AiUsageStatus = "ok" | "unconfigured" | "error"

/**
 * 1日を超える制限枠（週間など）で、枠の中の「1日の終わり」に立てる区切り。
 *
 * 位置に使うのは時刻ではなく**その時点までの累計使用率**で、隣り合う区切りの間隔が
 * その日に使った量になる。値は取得のたびに記録したものを読んでいるため、
 * 一度も画面を開かなかった日の区切りは存在しない（配列から抜ける）。
 */
export interface AiUsageDayMark {
    /** 枠の開始から数えて何日目の終わりか（1始まり） */
    day: number
    /** その時点までの累計使用率（0-100） */
    usedPercent: number
    /** 区切りの時刻（ISO 8601） */
    at: string
    /** この値を観測した時刻（ISO 8601）。区切りより前になるため、ズレの大きさが分かる */
    observedAt: string
}

export interface AiUsageWindow {
    /** 制限枠の表示名（例: "5時間", "週間"） */
    label: string
    /** 使用率（0-100） */
    usedPercent: number
    /** 制限枠がリセットされる時刻（ISO 8601）。不明なら null */
    resetsAt: string | null
    /** 制限枠の長さ（秒）。不明なら null。resetsAt と組み合わせて経過時間を出すのに使う */
    windowSeconds: number | null
    /** 補足表示（例: "Opus"） */
    note?: string
    /** 1日ごとの区切り。1日を超える枠でだけ入り、記録が無ければ空配列 */
    dayMarks?: AiUsageDayMark[]
}

/** APIの呼び出し元が記録した、上限を持たない従量課金の利用量 */
export interface AiMeteredTotals {
    calls: number
    inputTokens: number
    /** 入力トークン単価から計算したUSDの概算。提供元の請求額そのものではない */
    estimatedCostUsd: number
}

/** 従量課金の用途別内訳 */
export interface AiMeteredFeatureUsage {
    label: string
    last24h: AiMeteredTotals
    last7d: AiMeteredTotals
}

/** 上限を返さない提供元向けの実測使用量 */
export interface AiProviderMeteredUsage {
    last24h: AiMeteredTotals
    last7d: AiMeteredTotals
    features: AiMeteredFeatureUsage[]
    /** 集計の開始からの累計入力トークン数。連携先が返さなければ無い（クレジット残高の消費額に使う。#426） */
    totalInputTokens?: number
}

/**
 * サブスクの制限枠とは別会計のクレジット枠。
 * Claude は月ごとの追加利用（使った分だけ課金される）、ChatGPT は前払いで買ったクレジットの残高で、
 * 単位も期限の有無も違う。画面では同じ1行として出すため、整形済みの文字列で受け取る。
 */
export interface AiProviderCredit {
    /** 右上に大きく出す値（例: "残り $68.18", "残り 1,200 クレジット", "無制限", "未設定"） */
    valueText: string
    /** 使用率（0-100）。上限が無く割合を出せない場合は null（バーを出さない） */
    usedPercent: number | null
    /** 左下に出す内訳（例: "購入 $131.82 / 上限 $200.00"）。無ければ null */
    detailText: string | null
    /** 枠がリセットされる時刻（ISO 8601）。期限が無ければ null */
    resetsAt: string | null
    /**
     * 購入クレジットの失効日時（ISO 8601、Jevのみ）。resetsAtと違い、この時刻が来ても残高は
     * 補充されず、使い切っていない分が消える。resetsAtとは文言を分けるため別フィールドにしている
     */
    expiresAt?: string | null
    /** 当月の追加利用の生の値（Claudeのみ）。台帳の使用額の積み上げに使う */
    monthly?: AiCreditMonthly
    /** 手入力の購入・残高の台帳（Claudeのみ）。画面から編集するための値 */
    ledger?: ClaudeCreditLedgerView
    /**
     * 購入済みでまだ使っていない残高が、月の上限の何割にあたるか（0-100）。使用済みの右隣に塗る。
     * 上限か推定残高が分からないとき、残高がゼロのときは無い
     */
    reservedPercent?: number
}

/** 当月の追加利用。金額は最小単位（USDならセント） */
export interface AiCreditMonthly {
    usedMinor: number
    /** 月の上限。null なら上限なし */
    limitMinor: number | null
    currency: string
    decimals: number
}

/** 手入力したクレジット購入1件 */
export interface ClaudeCreditPurchaseView {
    id: string
    /** 購入日（YYYY-MM-DD） */
    date: string
    /** 金額（USD） */
    amount: number
    /** 有効期限（YYYY-MM-DD）。購入日から1年 */
    expiresOn: string
    expired: boolean
}

/**
 * Claudeのクレジット残高は claude.ai の非公開APIがCloudflareに阻まれて取れないため（#252）、
 * 購入と「ある時点の残高」を手で登録し、そこからの使用額を差し引いて推定する。
 */
export interface ClaudeCreditLedgerView {
    /** 新しい購入から順 */
    purchases: ClaudeCreditPurchaseView[]
    /** 有効期限内の購入の合計（表示用）。購入が無ければ null */
    activePurchasedText: string | null
    /** 推定残高（表示用）。補正をまだしていなければ null */
    balanceText: string | null
    /** 推定残高（最小単位。USDならセント）。補正をまだしていなければ null */
    balanceMinor: number | null
    /** 最後に補正した時刻（ISO 8601）と、そのときに入力した残高（表示用） */
    correctedAt: string | null
    correctedBalanceText: string | null
}

/**
 * 制限枠1つぶんの実績。提供元は過去の枠を返さないため、
 * ダッシュボード側で観測して積み上げた値になる（src/lib/ai-usage/history.ts）。
 */
export interface AiUsageWindowRecord {
    /** 枠のリセット時刻（ISO 8601）。枠の識別子も兼ねる */
    resetsAt: string
    /** その枠で観測できた最大の使用率（0-100） */
    usedPercent: number
    /** まだ終わっていない枠か */
    inProgress: boolean
    /** 枠の終了間際に観測できておらず、実際より低い値で確定している可能性があるか */
    undersampled: boolean
}

/** 制限枠の種類（5時間・週間 …）ごとの使い切り実績 */
export interface AiUsageWindowHistory {
    /** 枠の表示名（{@link AiUsageWindow.label} と同じ） */
    label: string
    note?: string
    windowSeconds: number
    /** リセット時刻の古い順。進行中の枠があれば末尾に入る */
    records: AiUsageWindowRecord[]
    /** 終わった枠の平均使い切り率（0-100）。終わった枠がまだ無ければ null */
    averagePercent: number | null
    /** 使い切った枠の数 */
    fullCount: number
    /** 平均・使い切り回数の母数（終わった枠の数） */
    completedCount: number
}

/**
 * 週間枠が5時間枠の何倍に当たるかの推定（src/lib/ai-usage/history.ts）。
 * 提供元は使用率しか返さないため、今週の5時間枠の使用率の合計 ÷ 週間枠の使用率で求める。
 */
export interface AiWeeklyMultiple {
    /** 倍率。週間使用率が小さすぎて推定できないときは null（計測中） */
    multiple: number | null
    /** 集計した今週の5時間枠の数 */
    fiveHourCount: number
    /** 集計した5時間枠の使用率の合計（%） */
    fiveHourTotalPercent: number
    /** 分母にした週間枠の使用率（%） */
    weeklyPercent: number
    /** 観測が足りない5時間枠を含み、実際より小さく出ている可能性があるか */
    lowerBound: boolean
}

export interface AiProviderUsage {
    id: AiProviderId
    name: string
    /** 課金プランの表示名。取得も設定もできない場合は null */
    plan: string | null
    status: AiUsageStatus
    /** status が ok 以外のときに表示する理由 */
    message?: string
    /**
     * 権限が足りず取得できないとき true（401・403・スコープ不足）。画面は「取得失敗」ではなく
     * 「表示できません」と理由を出す。message には直し方を添える
     */
    denied?: boolean
    windows: AiUsageWindow[]
    credit?: AiProviderCredit
    /** TypeSafeのように上限ではなく実測値だけを返す提供元の使用量 */
    metered?: AiProviderMeteredUsage
    /** 終わった枠の使い切り実績。記録がまだ無ければ省略される */
    windowHistory?: AiUsageWindowHistory[]
    /** 週間枠が5時間枠の何倍か（Claudeのみ）。記録がまだ無ければ省略される */
    weeklyMultiple?: AiWeeklyMultiple
    /**
     * リフレッシュトークン自体の失効予定（ISO 8601）。提供元がトークン更新の応答で返したときだけ付く。
     * 過ぎると再ログインしてトークンを差し替えるしかない（#641）
     */
    refreshTokenExpiresAt?: string
}

export interface AiUsageSnapshot {
    providers: AiProviderUsage[]
    /** 各提供元へ問い合わせた時刻（ISO 8601） */
    fetchedAt: string
}
