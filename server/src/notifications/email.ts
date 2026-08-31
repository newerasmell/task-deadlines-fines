import nodemailer, { Transporter } from "nodemailer";
import { env } from "../lib/env";
import { ChannelSendResult, NotificationChannelAdapter, NotificationMessage, NotificationTarget } from "./types";

export class EmailAdapter implements NotificationChannelAdapter {
  readonly channel = "EMAIL" as const;
  private transporter: Transporter | null = null;

  isConfigured(): boolean {
    return Boolean(env.smtpHost && env.smtpUser && env.smtpPass);
  }

  hasTarget(target: NotificationTarget): boolean {
    return Boolean(target.email);
  }

  private getTransporter(): Transporter {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: env.smtpHost,
        port: env.smtpPort,
        secure: env.smtpSecure,
        auth: { user: env.smtpUser, pass: env.smtpPass },
      });
    }
    return this.transporter;
  }

  async send(target: NotificationTarget, message: NotificationMessage): Promise<ChannelSendResult> {
    if (!this.isConfigured()) {
      return { channel: this.channel, status: "SKIPPED", error: "SMTP_HOST/SMTP_USER/SMTP_PASS not set" };
    }
    if (!this.hasTarget(target)) {
      return { channel: this.channel, status: "SKIPPED", error: "User has no email" };
    }

    try {
      await this.getTransporter().sendMail({
        from: env.smtpFrom,
        to: target.email!,
        subject: message.subject,
        text: message.body,
      });
      return { channel: this.channel, status: "SENT" };
    } catch (err) {
      return { channel: this.channel, status: "FAILED", error: (err as Error).message };
    }
  }
}
