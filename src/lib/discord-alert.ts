import { describeError, fetchWithTimeout, readErrorBody } from "@/lib/upstream";

/** Discord の embed で使う色（異常は赤） */
const COLOR_ALERT = 15548997;

interface DiscordField {
  name: string;
  value: string;
  inline?: boolean;
}

/**
 * WebhookへJSONを1件投げ、届いたかどうかを返す。例外は投げない（呼び出し元は止めない）。
 *
 * **`fetch` は5xxでも例外を投げない**ため、`res.ok` を見ないと「Discord側が受け取れなかった」
 * ことが分からず、失敗がログにも残らない。応答しない相手にも待たされないよう、タイムアウトを付ける
 * （エージェントの `POST /api/host-stats` やログインの完了が、この送信の完了を待っているため）。
 */
async function postWebhook(webhookUrl: string, body: unknown, label: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return true;

    // URLがWebhookの認証を兼ねるため、ログにはURLを出さずステータスと本文だけを残す
    console.error(`[discord-alert] ${label}の送信が拒否されました: ${res.status} ${await readErrorBody(res)}`);
  } catch (error) {
    console.error(`[discord-alert] ${label}の送信に失敗しました:`, describeError(error));
  }
  return false;
}

/**
 * 異常をDiscordへ通知する（#625。Signalyの廃止後の経路）。
 *
 * 全リポジトリ共通の異常通知用Webhook（`DISCORD_ALERT_WEBHOOK_URL`。1Passwordの `apps/Notify` の
 * `alert-webhook-url`）へ送る。未設定なら何もしない（通知だけが無効になり、画面表示はそのまま動く）。
 * **異常だけを送る。** 成功・復旧・通常ログインは通知しない方針のため、`kind` は持たない。
 *
 * URL未設定は通知が無効なだけなので `true`（送るものが無い）を返す。`false` にすると、呼び出し元が
 * 「送れていないから再送する」と毎回やり直し続けてしまう。
 *
 * **届いたかどうかを返す**。呼び出し元が「通知済み」を記録するのは、`true` のときだけにすること。
 * 送れなかったのに記録すると、その通知は二度と再送されない。
 */
export async function notifyDiscordAlert(input: {
  /** 「定期ジョブの異常」のような、通知一覧で読める見出し */
  title: string;
  /** 見出しだけでは足りない補足。何が起きているかを1〜2行で */
  description?: string;
  fields?: DiscordField[];
}): Promise<boolean> {
  const webhookUrl = process.env.DISCORD_ALERT_WEBHOOK_URL;
  if (!webhookUrl) return true;

  const timestamp = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  const fields = [...(input.fields ?? []), { name: "時刻", value: timestamp }];

  return postWebhook(
    webhookUrl,
    {
      embeds: [
        {
          title: `🚨 ${input.title}`,
          description: input.description,
          color: COLOR_ALERT,
          fields: fields.map((field) => ({ inline: false, ...field })),
        },
      ],
    },
    "アラート通知",
  );
}
