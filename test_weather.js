const lat = 52.0464;
const lon = -4.3151;
const cityName = "52.0464, -4.3151";

async function testFetch() {
    console.log("Starting Nominatim reverse geocoding and weather fetch test...");
    let resolvedName = cityName;
    try {
        const revRes = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=en`, {
            headers: { 'Accept-Language': 'en', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        console.log("Nominatim status:", revRes.status);
        const revData = await revRes.json();
        console.log("Nominatim response data:", JSON.stringify(revData).substring(0, 300));
        if (revData && revData.display_name) {
            const addr = revData.address;
            resolvedName = addr.city || addr.town || addr.village || addr.suburb || addr.municipality || addr.county || revData.display_name.split(',')[0];
        }
    } catch (e) {
        console.warn("Reverse geocoding failed, using default", e);
    }

    console.log("Resolved Name:", resolvedName);
}

testFetch();
