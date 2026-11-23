/**
 * 概要カードから詳細タブの該当箇所へ移動するためのアンカー（#682）。
 * DOMに触れない純関数だけをここに置き、`node:test` で確かめられるようにしている。
 */

/** 移動先のsectionに付けるid。ホストIDに使えない文字が来ても、idとして壊れない形にする */
export function hostAnchorId(hostId: string): string {
    return `host-${hostId.replace(/[^A-Za-z0-9_-]/g, "-")}`
}

export const SECTION_ANCHORS = {
    tmux: "section-tmux",
    aiUsage: "section-ai-usage",
    githubUsage: "section-github-usage",
    monitors: "section-monitors",
    aideJobs: "section-aide-jobs",
    aideConnectors: "section-aide-connectors",
} as const

/** カードの中にあって、押したときは遷移ではなく本来の操作をしてほしい要素 */
const INTERACTIVE_SELECTOR = "a, button, input, select, textarea, summary, label, [role='button'], [role='link']"

/**
 * カード全体のクリックを遷移として扱うか。
 * 内側のリンク・ボタンの操作と、文字を選択するためのドラッグは遷移させない。
 */
export function shouldJumpOnClick(
    target: { closest(selector: string): unknown } | null,
    hasTextSelection: boolean
): boolean {
    if (hasTextSelection) return false
    if (!target) return true
    return !target.closest(INTERACTIVE_SELECTOR)
}
