// 전화번호 입력 중 자동 하이픈. 숫자만 남긴 뒤 한국 전화번호 자릿수 규칙에 맞춰 끊는다.

/** 숫자를 [앞, 가운데, 뒤] 길이대로 나눠 하이픈으로 잇기 (입력 중이라 모자란 부분은 있는 만큼만) */
function split(digits: string, sizes: readonly number[]): string {
  const parts: string[] = [];
  let i = 0;
  for (const size of sizes) {
    if (i >= digits.length) break;
    parts.push(digits.slice(i, i + size));
    i += size;
  }
  if (i < digits.length) parts[parts.length - 1] += digits.slice(i);
  return parts.join("-");
}

/**
 * 전화번호 자동 하이픈.
 * - 02 서울: 02-123-4567 / 02-1234-5678
 * - 15xx·16xx·18xx 대표번호: 1588-1234
 * - 050x 안심번호: 0505-123-4567 / 0505-1234-5678
 * - 그 밖 (010 휴대폰, 031 등 지역번호, 070): 010-123-4567 / 010-1234-5678
 * 숫자가 아닌 글자는 버림. 입력 중인 짧은 번호도 자연스럽게 끊음.
 */
export function formatPhoneNumber(value: string): string {
  const d = value.replace(/\D/g, "").slice(0, 12);
  if (d.length === 0) return "";

  if (d.startsWith("02")) {
    // 02-XXX-XXXX(9자리) / 02-XXXX-XXXX(10자리)
    return split(d.slice(0, 10), d.length <= 9 ? [2, 3, 4] : [2, 4, 4]);
  }
  if (/^1[568]/.test(d)) {
    return split(d.slice(0, 8), [4, 4]);
  }
  if (/^050/.test(d)) {
    return split(d, d.length <= 11 ? [4, 3, 4] : [4, 4, 4]);
  }
  const n = d.slice(0, 11);
  return split(n, n.length <= 10 ? [3, 3, 4] : [3, 4, 4]);
}
