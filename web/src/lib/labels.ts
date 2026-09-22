import type { AdAccountStatus, ApiErrorCode } from "../api/types";

export const DATE_PRESETS = [
  { key: "today", label: "Bugün" },
  { key: "yesterday", label: "Dün" },
  { key: "last_7d", label: "Son 7 gün" },
  { key: "last_14d", label: "Son 14 gün" },
  { key: "last_30d", label: "Son 30 gün" },
  { key: "this_month", label: "Bu ay" },
  { key: "last_month", label: "Geçen ay" },
  { key: "custom", label: "Özel aralık" },
] as const;

export type DatePresetKey = (typeof DATE_PRESETS)[number]["key"];

export function datePresetLabel(key: string): string {
  return DATE_PRESETS.find((preset) => preset.key === key)?.label ?? key;
}

export const ACCOUNT_STATUS_LABELS: Record<AdAccountStatus, string> = {
  ACTIVE: "Aktif",
  DISABLED: "Devre dışı",
  UNSETTLED: "Ödeme bekliyor",
  PENDING_RISK_REVIEW: "Risk incelemesi",
  PENDING_SETTLEMENT: "Mutabakat bekliyor",
  IN_GRACE_PERIOD: "Ek süre",
  PENDING_CLOSURE: "Kapanış bekliyor",
  CLOSED: "Kapalı",
  ANY_ACTIVE: "Aktif",
  ANY_CLOSED: "Kapalı",
  UNKNOWN: "Bilinmiyor",
};

export const CAMPAIGN_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "Aktif",
  PAUSED: "Duraklatıldı",
  ARCHIVED: "Arşivlendi",
  DELETED: "Silindi",
  IN_PROCESS: "İşleniyor",
  WITH_ISSUES: "Sorunlu",
  CAMPAIGN_PAUSED: "Kampanya duraklatıldı",
  ADSET_PAUSED: "Reklam seti duraklatıldı",
};

export function campaignStatusLabel(status: string): string {
  return CAMPAIGN_STATUS_LABELS[status] ?? status;
}

export const CAMPAIGN_STATUS_FILTERS = [
  { key: "ALL", label: "Tüm durumlar" },
  { key: "ACTIVE", label: "Aktif" },
  { key: "PAUSED", label: "Duraklatıldı" },
  { key: "ARCHIVED", label: "Arşivlendi" },
  { key: "DELETED", label: "Silindi" },
] as const;

export type CampaignStatusFilter = (typeof CAMPAIGN_STATUS_FILTERS)[number]["key"];

/**
 * Turkish copy for each machine code the API returns. The API stays
 * language-agnostic; every user-visible string for an error lives here.
 */
export const ERROR_MESSAGES: Record<ApiErrorCode, string> = {
  unauthenticated: "Oturumunuz sona erdi. Meta ile yeniden giriş yapın.",
  meta_not_connected: "Meta bağlantısı bulunamadı. Hesabınızı bağlayın.",
  meta_connection_expired: "Meta bağlantısı sona erdi. Yeniden bağlanın.",
  account_forbidden: "Bu reklam hesabına erişim yetkiniz yok.",
  invalid_request: "İstek geçersiz. Filtreleri kontrol edip tekrar deneyin.",
  rate_limited: "Çok fazla istek gönderildi. Kısa bir süre sonra tekrar deneyin.",
  meta_rate_limited: "Meta bu hesap için istekleri sınırlıyor. Biraz sonra tekrar deneyin.",
  upstream_error: "Meta tarafından veri alınamadı.",
  server_error: "Beklenmeyen bir hata oluştu.",
  ai_not_configured:
    "Claude AI bu sunucuda yapılandırılmamış. Sunucu yöneticisinin ANTHROPIC_API_KEY tanımlaması gerekiyor.",
  ai_rate_limited: "Çok fazla AI isteği gönderildi. Kısa bir süre sonra tekrar deneyin.",
  ai_unavailable: "Claude şu anda yanıt veremedi. Biraz sonra tekrar deneyin.",
  ai_confirmation_expired:
    "Bu onay artık geçerli değil (süresi doldu ya da kullanıldı). İşlemi yeniden isteyin.",
  ai_write_stale:
    "Bu nesne, oneri hazirlandiktan sonra Meta tarafinda degisti. Hicbir sey gonderilmedi — guncel degerlerle yeniden sorun.",
  ai_writes_disabled:
    "Reklam degistirme yetkisi bu sunucuda kapali. Oneri hazirlandi ama Meta’ya hicbir istek gonderilmedi.",
  network_error: "Sunucuya ulaşılamadı. İnternet bağlantınızı kontrol edip tekrar deneyin.",
};


/**
 * Starter questions. They exist because an empty prompt box gets no use: each
 * one maps onto something the server actually sends to the model (summary,
 * period comparison, breakdown comparison, efficiency).
 */
export const AI_SUGGESTED_QUESTIONS = [
  "Son 30 günde reklamlarım nasıl gidiyor?",
  "Bugün satış neden düştü?",
  "Son 7 günde hangi reklam para kaybettiriyor?",
  "Hangi reklam setini kapatmalıyım?",
  "Bütçeyi nereye kaydırmalıyım?",
] as const;
