import type { QueueMessage } from './corpus';

declare global {
  namespace Cloudflare {
    interface Env {
      BETTER_AUTH_SECRET: string;
      QA_MASTER_KEY_B64: string;
      EVIDENCE_SIGNING_SECRET: string;
      CORPUS_MASTER_KEY_B64?: string;
      GOOGLE_CLIENT_ID?: string;
      GOOGLE_CLIENT_SECRET?: string;
      GITHUB_OAUTH_CLIENT_ID?: string;
      GITHUB_OAUTH_CLIENT_SECRET?: string;
      GITHUB_APP_ID?: string;
      GITHUB_APP_PRIVATE_KEY?: string;
      GITHUB_WEBHOOK_SECRET?: string;
      STRIPE_SECRET_KEY?: string;
      STRIPE_WEBHOOK_SECRET?: string;
      OPENAI_API_KEY?: string;
      /** Short-lived OpenAI Plugin directory domain-ownership challenge. */
      OPENAI_APPS_CHALLENGE_TOKEN?: string;
      ANTHROPIC_API_KEY?: string;
      XAI_API_KEY?: string;
      DEEPSEEK_API_KEY?: string;
      FIREWORKS_API_KEY?: string;
      OPENROUTER_API_KEY?: string;
      SCW_SECRET_KEY?: string;
      MOONSHOT_API_KEY?: string;
    }
  }
}

export interface HostedWorkflowParams {
  runId: string;
}

type GeneratedBindings = Omit<CloudflareBindings, 'WEBHOOK_QUEUE' | 'CORPUS_QUEUE'>;

export type Env = GeneratedBindings & {
  LEGACY_APP_URL: string;
  /** Non-secret email configured by the verified Glama publisher for domain ownership. */
  GLAMA_MAINTAINER_EMAIL?: string;
  WEBHOOK_QUEUE: Queue<QueueMessage>;
  CORPUS_QUEUE: Queue<QueueMessage>;
  BETTER_AUTH_SECRET: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_METER_EVENT_NAME: string;
  STRIPE_PRICE_ID: string;
  QA_MASTER_KEY_B64: string;
  EVIDENCE_SIGNING_SECRET: string;
  CORPUS_MASTER_KEY_B64?: string;
  OPENAI_API_KEY?: string;
  /** Short-lived OpenAI Plugin directory domain-ownership challenge. */
  OPENAI_APPS_CHALLENGE_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  XAI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  FIREWORKS_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  SCW_SECRET_KEY?: string;
  MOONSHOT_API_KEY?: string;
  CONTAINER_CPU_MICRO_USD_PER_VCPU_SECOND?: string;
  CONTAINER_MEMORY_MICRO_USD_PER_GIB_SECOND?: string;
  CONTAINER_DISK_MICRO_USD_PER_GB_SECOND?: string;
  R2_STORAGE_MICRO_USD_PER_GB_MONTH?: string;
};

export interface Principal {
  userId: string;
  workspaceId: string;
  role: 'admin' | 'member';
}
