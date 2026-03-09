import { normalizeCountryCode } from "../../app/data/countryMetadata";

interface CountryFlagProps {
  code: string | undefined;
  title?: string;
  ariaLabel?: string;
  className?: string;
}

export function CountryFlag({ code, title, ariaLabel, className }: CountryFlagProps) {
  const normalizedCode = normalizeCountryCode(code);
  if (normalizedCode === "") {
    return null;
  }
  const classes = ["country-flag-icon", "fi", `fi-${normalizedCode.toLowerCase()}`, className]
    .filter((value) => typeof value === "string" && value.trim() !== "")
    .join(" ");
  return <span className={classes} role="img" aria-label={ariaLabel ?? normalizedCode} title={title} />;
}
