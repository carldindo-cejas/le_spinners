/** A configured map pin takes precedence; older facilities keep address-based directions. */
export function facilityDirections(facility) {
  if (facility?.mapsUrl) {
    try {
      const url = new URL(facility.mapsUrl);
      if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
    } catch { /* Fall back to the address for incomplete/older configurations. */ }
  }
  const address = facility?.address?.trim();
  return address && !address.startsWith('[')
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}` : null;
}
