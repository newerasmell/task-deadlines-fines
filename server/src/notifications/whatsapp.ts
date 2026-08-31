import { env } from "../lib/env";
import { ChannelSendResult, NotificationChannelAdapter, NotificationMessage, NotificationTarget } from "./types";

/**
 * Uses the Meta WhatsApp Cloud API. Requires a verified WhatsApp Business
 * phone number and a pre-approved message template for the first contact
 * (Cloud API restricts free-form text to a 24h customer-service window), so
 * in production you would typically send a template message here instead of
 * plain text. See README for setup.
 */
export class WhatsAppAdapter implements NotificationChannelAdapter {
  readonly channel = "WHATSAPP" as const;

  isConfigured(): boolean {
    return Boolean(env.whatsappPhoneNumberId && env.whatsappAccessToken);
  }

  hasTarget(target: NotificationTarget): boolean {
    return Boolean(target.whatsappPhone);
  }

  async send(target: NotificationTarget, message: NotificationMessage): Promise<ChannelSendResult> {
    if (!this.isConfigured()) {
      return { channel: this.channel, status: "SKIPPED", error: "WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN not set" };
    }
    if (!this.hasTarget(target)) {
      return { channel: this.channel, status: "SKIPPED", error: "User has no whatsappPhone" };
    }

    const url = `https://graph.facebook.com/v20.0/${env.whatsappPhoneNumberId}/messages`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.whatsappAccessToken}`,
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: target.whatsappPhone,
          type: "text",
          text: { body: `${message.subject}\n${message.body}` },
        }),
      });
      if (!res.ok) {
        const errBody = await res.text();
        return { channel: this.channel, status: "FAILED", error: `HTTP ${res.status}: ${errBody}` };
      }
      return { channel: this.channel, status: "SENT" };
    } catch (err) {
      return { channel: this.channel, status: "FAILED", error: (err as Error).message };
    }
  }
}
