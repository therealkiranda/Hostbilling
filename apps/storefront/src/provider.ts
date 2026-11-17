/**
 * Finds which hosting provider this storefront is for. The first part of the address
 * wins (for example /example-hosting), then the build-time default.
 */
export function resolveProviderSlug(pathname: string, fallback: string | undefined): string | null {
  const segment = pathname.split('/').filter(Boolean)[0];
  const candidate = (segment ?? fallback ?? '').trim().toLowerCase();

  return /^[a-z0-9-]{1,63}$/.test(candidate) ? candidate : null;
}
