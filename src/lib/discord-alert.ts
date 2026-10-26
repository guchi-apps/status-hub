import { describeError, fetchWithTimeout, readErrorBody } from "@/lib/upstream";

/** Discord の embed の色。異常のみ通知するため赤だけ */
const COLOR_ALERT = 15548997;

export interface DiscordAlertField {
  name: string;
  value: string;
  inline?: boolean;
}

/**
 * 異常をDiscordのWebhook（`DISCORD_ALERT_WEBHOOK_URL`）へ1件投げる（#624。Signalyの代わり）。
 *
 * **異常だけを送る。** 成功・復旧・通常ログインなどは通知しない方針のため、復旧用の経路は持たない。
 * 未設定なら通知が無効なだけなので `true`（送るものが無い）を返す。`false` にすると呼び出し元が
 * 「送れていないから再送する」と毎回やり直し続けてしまう。
 *
 * **届いたかどうかを返す**。呼び出し元が「通知済み」を記録するのは `true` のときだけにすること。
 * `fetch` は5xxでも例外を投げないため `res.ok` を見る。URLがWebhookの認証を兼ねるので、
 * ログにはURLを出さずステータスと本文だけを残す。応答しない相手に呼び出し元（エージェントの
 * `POST /api/host-stats`）が待たされないよう、タイムアウトを付けている。
 */
export async function notifyDiscordAlert(input: {
  /** 「定期ジョブの異常: …」のような、通知一覧で読める見出し */
  title: string;
  description?: string;
  fields?: DiscordAlertField[];
}): Promise<boolean> {
  const webhookUrl = process.env.DISCORD_ALERT_WEBHOOK_URL;
  if (!webhookUrl) return true;

  const timestamp = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  const body = {
    // 本文にユーザー・ロールのメンションが紛れても通知を飛ばさない
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: `🚨 ${input.title}`,
        description: input.description,
        color: COLOR_ALERT,
        fields: [...(input.fields ?? []), { name: "時刻", value: timestamp }].map((field) => ({
          inline: false,
          ...field,
        })),
      },
    ],
  };

  try {
    const res = await fetchWithTimeout(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return true;

    console.error(`[discord-alert] 異常通知の送信が拒否されました: ${res.status} ${await readErrorBody(res)}`);
  } catch (error) {
    console.error("[discord-alert] 異常通知の送信に失敗しました:", describeError(error));
  }
  return false;
}
