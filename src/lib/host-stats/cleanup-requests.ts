import fs from "fs/promises"
import path from "path"
import { isAgentCleanupTarget, isCleanupTargetId } from "@/lib/host-stats/cleanup-targets"
import { ID_PATTERN } from "@/lib/host-stats/report"
import { getHostDataDir, writeFileAtomic } from "@/lib/host-stats/store"
import type { HostCleanupPending, HostStatsCleanup } from "@/types/host-stats"

/**
 * ディスクの掃除の依頼のキュー（#657）。tmux を閉じる依頼（`close-requests.ts`。#409）と同じく、
 * ダッシュボードからホストへ指示を送る経路が無いため、依頼をここへ積んでエージェントの毎分の
 * POST の応答（`cleanupRequests`）で渡す。
 *
 * 渡すのは対象のIDと依頼時刻だけで、パスは渡さない（消す場所と消し方はエージェント側に固定）。
 * エージェントは実行結果（`cleanup.targets[].lastRun`）を依頼時刻つきで送り返してくるので、
 * 同じ依頼時刻の結果が終わった状態で届いたら完了として捨てる。
 */

/** 受け取られないまま（エージェントが止まっている・掃除ユニットが未設置）の依頼を捨てるまでの時間 */
export const CLEANUP_QUEUED_TTL_MS = 15 * 60_000

/** 実行中のまま結果が戻らない依頼を捨てるまでの時間。掃除ユニットの TimeoutStartSec（1時間）より長く取る */
export const CLEANUP_RUNNING_TTL_MS = 2 * 3_600_000

export type CleanupEnqueueResult = "queued" | "exists" | "invalid" | "unsupported"

interface CleanupRequest extends HostCleanupPending {
    /** エージェントが受け取って実行を始めた（running の結果が届いた）か */
    started?: boolean
}

function getRequestsPath(hostId: string): string {
    return path.join(getHostDataDir(hostId), "cleanup-requests.json")
}

function assertHostId(hostId: string): void {
    if (!ID_PATTERN.test(hostId)) throw new Error("invalid host id")
}

let queue: Promise<unknown> = Promise.resolve()

function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task)
    queue = run.catch(() => undefined)
    return run
}

async function readRequests(hostId: string): Promise<CleanupRequest[]> {
    try {
        const parsed: unknown = JSON.parse(await fs.readFile(getRequestsPath(hostId), "utf8"))
        if (!Array.isArray(parsed)) return []

        return parsed.filter(
            (entry): entry is CleanupRequest =>
                typeof entry?.requestedAt === "number" &&
                Number.isInteger(entry.requestedAt) &&
                isCleanupTargetId(entry.target) &&
                isAgentCleanupTarget(entry.target)
        )
    } catch {
        return []
    }
}

async function writeRequests(hostId: string, requests: CleanupRequest[]): Promise<void> {
    await writeFileAtomic(getRequestsPath(hostId), `${JSON.stringify(requests, null, 2)}\n`)
}

function isAlive(request: CleanupRequest, now: number): boolean {
    const ttl = request.started ? CLEANUP_RUNNING_TTL_MS : CLEANUP_QUEUED_TTL_MS
    return now - request.requestedAt < ttl
}

/** 依頼を積む。エージェントが掃除できると申告している対象だけを受け付ける */
export async function enqueueCleanupRequest(
    hostId: string,
    target: unknown,
    cleanup: HostStatsCleanup | undefined,
    now: number = Date.now()
): Promise<CleanupEnqueueResult> {
    assertHostId(hostId)
    if (!isCleanupTargetId(target) || !isAgentCleanupTarget(target)) return "invalid"
    if (!cleanup?.targets.some((entry) => entry.id === target)) return "unsupported"

    return serialize(async () => {
        const requests = (await readRequests(hostId)).filter((request) => isAlive(request, now))
        if (requests.some((request) => request.target === target)) return "exists"

        await writeRequests(hostId, [...requests, { target, requestedAt: now }])
        return "queued"
    })
}

/**
 * 受信のたびに呼ぶ。終わった依頼・期限切れの依頼を捨て、まだ始まっていないものを
 * `<対象>:<依頼時刻>` の形で返す（エージェントへ渡す）。
 */
export async function settleCleanupRequests(
    hostId: string,
    cleanup: HostStatsCleanup | undefined,
    now: number = Date.now()
): Promise<string[]> {
    assertHostId(hostId)

    return serialize(async () => {
        const before = await readRequests(hostId)
        if (before.length === 0) return []

        let changed = false
        const remaining: CleanupRequest[] = []
        for (const request of before) {
            const run = cleanup?.targets.find((entry) => entry.id === request.target)?.lastRun
            const sameRun = run !== undefined && run.requestedAt === request.requestedAt

            // 同じ依頼の結果が終わった状態で届いた、またはそれより新しい依頼が実行された
            if (run !== undefined && run.requestedAt >= request.requestedAt && !(sameRun && run.status === "running")) {
                changed = true
                continue
            }

            const next = sameRun && !request.started ? { ...request, started: true } : request
            if (next !== request) changed = true

            if (!isAlive(next, now)) {
                changed = true
                continue
            }
            remaining.push(next)
        }

        if (changed) await writeRequests(hostId, remaining)

        return remaining
            .filter((request) => !request.started)
            .map((request) => `${request.target}:${request.requestedAt}`)
    })
}

/** 画面に出す、まだ終わっていない依頼。書き換えはしない（期限切れは除いて返すだけ） */
export async function readPendingCleanup(
    hostId: string,
    now: number = Date.now()
): Promise<HostCleanupPending[]> {
    assertHostId(hostId)
    const requests = await readRequests(hostId)
    return requests
        .filter((request) => isAlive(request, now))
        .map(({ target, requestedAt }) => ({ target, requestedAt }))
}
