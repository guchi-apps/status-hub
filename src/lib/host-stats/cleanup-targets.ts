import type { HostCleanupTargetId } from "@/types/host-stats"

/**
 * ディスクの掃除の対象（#657）。画面の並び順もこの順。
 *
 * **消す場所と消し方の正はエージェント（`scripts/host-stats/agent.sh` の `--cleanup`）。**
 * ここは画面に出す説明だけで、パスはダッシュボードからエージェントへ渡さない。
 * 対象を足すときは agent.sh の `CLEANUP_IDS` と合わせる。
 *
 * クライアントからも読むため、`node:fs` などサーバー専用のものを import しない。
 */
export interface CleanupTargetInfo {
    id: HostCleanupTargetId
    label: string
    description: string
    /** 画面に添える場所の表示。実際の削除には使わない */
    location?: string
    /** 押したときの確認文 */
    confirm: string
}

export const CLEANUP_TARGETS: readonly CleanupTargetInfo[] = [
    {
        id: "tmux-stale",
        label: "tmuxの放置セッション",
        description: "デタッチのまま24時間以上動きが無いセッションを閉じます。",
        confirm: "放置セッションをまとめて閉じます。中で動いていたものは終了します。",
    },
    {
        id: "worktrees",
        label: "マージ済みIssueのworktree",
        description:
            "未コミット・未push・セッション稼働中のものは残します（issue-deckの掃除スクリプト）。",
        location: "~/apps/*-worktrees",
        confirm: "マージ先に取り込まれたworktreeとブランチを削除します。数分かかります。",
    },
    {
        id: "node-compile-cache",
        label: "Nodeのコンパイルキャッシュ",
        description: "次に起動したときに作り直されます。",
        location: "/tmp/node-compile-cache",
        confirm: "/tmp/node-compile-cache の中身を削除します。元に戻せません。",
    },
    {
        id: "npm-cache",
        label: "npmのキャッシュ",
        description: "次の npm ci が少し遅くなるだけです。",
        location: "~/.npm/_cacache",
        confirm: "~/.npm/_cacache を削除します。元に戻せません。",
    },
    {
        id: "tmp-stale",
        label: "/tmpの古い一時ファイル",
        description:
            "3日以上更新が無いテストの残骸など。tmuxのソケット・上の対象・Claudeの作業場は除きます。",
        location: "/tmp/*（ユーザー所有）",
        confirm: "/tmp 直下の、3日以上更新が無いユーザー所有のファイル・フォルダを削除します。",
    },
    {
        id: "claude-scratch",
        label: "Claude Codeの古い作業場",
        description: "3日以上使われていない一時ファイル・フォルダ。",
        location: "/tmp/claude-<UID>/*",
        confirm: "/tmp/claude-<UID> の中で3日以上更新が無いものを削除します。",
    },
]

export const CLEANUP_TARGET_IDS: readonly HostCleanupTargetId[] = CLEANUP_TARGETS.map((target) => target.id)

export function isCleanupTargetId(value: unknown): value is HostCleanupTargetId {
    return typeof value === "string" && (CLEANUP_TARGET_IDS as readonly string[]).includes(value)
}

/** ダッシュボードが依頼を積み、エージェントの掃除ユニットが実行する対象。tmux は既存の閉じる依頼（#409）で扱う */
export function isAgentCleanupTarget(id: HostCleanupTargetId): boolean {
    return id !== "tmux-stale"
}
