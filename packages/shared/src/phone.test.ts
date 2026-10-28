import { describe, expect, it } from "vitest";
import { formatPhoneNumber } from "./phone.ts";

describe("formatPhoneNumber", () => {
  it("휴대폰", () => {
    expect(formatPhoneNumber("01012345678")).toBe("010-1234-5678");
    expect(formatPhoneNumber("0101234567")).toBe("010-123-4567");
    expect(formatPhoneNumber("010-1234-5678")).toBe("010-1234-5678");
    expect(formatPhoneNumber("010 1234 5678")).toBe("010-1234-5678");
  });

  it("입력 중인 짧은 번호", () => {
    expect(formatPhoneNumber("0")).toBe("0");
    expect(formatPhoneNumber("010")).toBe("010");
    expect(formatPhoneNumber("0101")).toBe("010-1");
    expect(formatPhoneNumber("010123")).toBe("010-123");
    expect(formatPhoneNumber("0101234")).toBe("010-123-4");
    expect(formatPhoneNumber("")).toBe("");
  });

  it("서울 02", () => {
    expect(formatPhoneNumber("021234567")).toBe("02-123-4567");
    expect(formatPhoneNumber("0212345678")).toBe("02-1234-5678");
    expect(formatPhoneNumber("021")).toBe("02-1");
  });

  it("지역번호·인터넷전화", () => {
    expect(formatPhoneNumber("0311234567")).toBe("031-123-4567");
    expect(formatPhoneNumber("03112345678")).toBe("031-1234-5678");
    expect(formatPhoneNumber("07012345678")).toBe("070-1234-5678");
  });

  it("대표번호·안심번호", () => {
    expect(formatPhoneNumber("15881234")).toBe("1588-1234");
    expect(formatPhoneNumber("050512345678")).toBe("0505-1234-5678");
  });

  it("숫자가 아닌 글자는 버리고, 자릿수를 넘는 숫자는 자름", () => {
    expect(formatPhoneNumber("abc010-12a34-5678")).toBe("010-1234-5678");
    expect(formatPhoneNumber("010123456789")).toBe("010-1234-5678");
  });
});
