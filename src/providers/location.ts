import type { TargetConfig } from '../lib/types.js';

/**
 * 検索エンジンに渡す「利用者の位置」ヒント。
 * 既定は国（JP）とタイムゾーンだけで、市区町村や緯度経度は config/targets/<slug>.json の
 * "searchLocation" で明示した場合のみ渡す（地域名なしの質問を地域に誘導しないため）。
 */
export interface SearchLocation {
  /** ISO 3166-1 alpha-2 */
  country: string;
  city?: string;
  region?: string;
  /** IANA timezone */
  timezone?: string;
  latitude?: number;
  longitude?: number;
}

export const DEFAULT_LOCATION: SearchLocation = { country: 'JP', timezone: 'Asia/Tokyo' };

export function searchLocationFor(target: TargetConfig): SearchLocation {
  return { ...DEFAULT_LOCATION, ...(target.searchLocation ?? {}) };
}

/** レポートの計測方法欄に載せる説明 */
export function describeLocation(loc: SearchLocation): string {
  const parts = [loc.country];
  if (loc.region) parts.push(loc.region);
  if (loc.city) parts.push(loc.city);
  if (loc.latitude !== undefined && loc.longitude !== undefined) parts.push(`${loc.latitude},${loc.longitude}`);
  return parts.join(' / ');
}
