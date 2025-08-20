export async function onRequest({ request }) {
  const cf = request.cf || {};
  const body = {
    country: cf.country || null,
    city: cf.city || null,
    latitude: cf.latitude ? Number(cf.latitude) : null,
    longitude: cf.longitude ? Number(cf.longitude) : null,
  };
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}
