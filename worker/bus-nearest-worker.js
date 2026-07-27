export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const lat = parseFloat(url.searchParams.get('lat'));
    const lon = parseFloat(url.searchParams.get('lon'));
    if (isNaN(lat) || isNaN(lon)) {
      return new Response('Missing lat/lon', { status: 400 });
    }

    const ACCOUNT_KEY = env.LTA_API_KEY; // set this in Worker Settings > Variables
    const headers = { AccountKey: ACCOUNT_KEY, accept: 'application/json' };

    // LTA BusStops API returns max 500 records per call, paginated via $skip.
    // Fetch all pages in parallel (fast, one round trip).
    const skips = [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500];
    const pages = await Promise.all(
      skips.map((skip) =>
        fetch(`https://datamall2.mytransport.sg/ltaodataservice/BusStops?$skip=${skip}`, { headers })
          .then((r) => r.json())
          .catch(() => ({ value: [] }))
      )
    );
    const allStops = pages.flatMap((p) => p.value || []);

    if (allStops.length === 0) {
      return new Response('Could not load bus stop list — check LTA_API_KEY', { status: 502 });
    }

    function dist(lat1, lon1, lat2, lon2) {
      const R = 6371000;
      const toRad = (d) => (d * Math.PI) / 180;
      const dLat = toRad(lat2 - lat1);
      const dLon = toRad(lon2 - lon1);
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    // Nearest 4 stops (better coverage of both directions of a road / an intersection)
    const nearest = allStops
      .map((s) => ({ ...s, d: dist(lat, lon, s.Latitude, s.Longitude) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 4);

    const arrivals = await Promise.all(
      nearest.map((s) =>
        fetch(`https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival?BusStopCode=${s.BusStopCode}`, {
          headers,
        })
          .then((r) => r.json())
          .catch(() => null)
      )
    );

    function minsFromNow(iso) {
      if (!iso) return null;
      const mins = Math.round((new Date(iso) - new Date()) / 60000);
      return mins <= 0 ? 'Now' : `${mins}min`;
    }

    const lines = [];
    nearest.forEach((stop, i) => {
      const data = arrivals[i];
      lines.push(`【${stop.Description} ${stop.BusStopCode}】(${Math.round(stop.d)}m)`);
      if (!data || !data.Services || data.Services.length === 0) {
        lines.push('暂无班次信息');
      } else {
        data.Services.forEach((svc) => {
          const times = [svc.NextBus, svc.NextBus2, svc.NextBus3]
            .map((b) => minsFromNow(b?.EstimatedArrival))
            .filter(Boolean);
          lines.push(`${svc.ServiceNo}: ${times.join(', ')}`);
        });
      }
      lines.push('');
    });

    return new Response(lines.join('\n').trim(), {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
};
