# Ev Güvenlik Kamerası (PWA • WebRTC 1-to-N)

Eski/sabit Android veya masaüstü cihazları WebRTC tabanlı çoklu güvenlik kamerasına dönüştüren, build aracı gerektirmeyen (zero-build) modüler Progressive Web App.

## Özellikler

- **WebRTC 1-to-N Canlı Yayın:** Tekli büyük ekran ve **2×2 Çoklu İzleme** modu (2×2 modunda kamera otomatik olarak bitrate ve çözünürlüğü ölçekler).
- **7/24 Dayanıklılık:** `.info/connected` ile ağ kesintisi sonrası otomatik yeniden kayıt, oda çakışma (session takeover) koruması, `Screen Wake Lock` ve siyah ekran karartma.
- **İzleyici Toparlama:** `MAX_VIEWERS` dolu bildirimi, üstel geri çekilmeli (exponential backoff) otomatik yeniden bağlanma ve canlı `P2P / TURN + RTT` bağlantı göstergesi.
- **Hareket Algılama & Alarm:** Işık/pozlama değişimi telafili (mean-subtracted) hareket algılama, **8×6 interaktif ROI bölge maskeleme**, Telegram anlık fotoğraf + video klip (hibrit) alarmı ve iki yönlü Bas-Konuş (PTT).
- **P2P `RTCDataChannel` Kontrol & Snapshot:** Tekli izleyici bağlıyken uzaktan komutlar ve anlık fotoğraflar Firebase RTDB kotası harcamadan doğrudan şifreli WebRTC DataChannel üzerinden aktarılır (bağlı değilse otomatik RTDB yedeği çalışır).
- **Cihaz Sağlık Telemetrisi:** Kamera pil yüzdesi ve şarj durumu tüm izleyicilere gerçek zamanlı yansıtılır; şarj kesintisi (elektrik kesintisi) veya kritik düşük pil (%15) durumunda otomatik Telegram uyarısı gönderilir.
- **Kullanıcı Bazlı Veri İzolasyonu:** Firebase RTDB verileri `users/<uid>/...` altında tutulur.
- **Ephemeral TURN & Güvenli Telegram Proxy:** İsteğe bağlı tek Cloudflare Worker ile mobil CGNAT aşımı (Cloudflare Calls TURN) ve sunucu tarafında saklanan Telegram Bot Token desteği.

## Klasör Yapısı

```text
├── index.html                  # Uygulama HTML iskeleti
├── manifest.json               # PWA manifest
├── sw.js                       # Network-First Service Worker
├── database.rules.json         # Firebase Realtime Database güvenlik kuralları
├── styles/main.css             # Stiller
├── src/
│   ├── main.js                 # Uygulama giriş noktası
│   ├── config.js               # Yapılandırma, bitrate profilleri ve RTDB yolları
│   ├── state.js                # Merkezi state & yardımcılar
│   ├── services/               # Firebase, ICE/TURN, Telegram, Dizin, PWA, Ağ UI
│   ├── webrtc/                 # Ortak ViewerPeerSession sınıfı
│   ├── camera/                 # Yayıncı, Hareket, Kayıt, Siren, WakeLock
│   └── viewer/                 # Tekli, 2×2 Grid, PTT ve Koordinatör
└── worker/
    ├── cloudflare-worker.js    # Ephemeral TURN + Telegram Proxy Worker
    └── wrangler.toml           # Cloudflare Wrangler yapılandırması
```

## Kurulum

### 1. Firebase Realtime Database Kuralları
Firebase Console → **Realtime Database → Rules** sekmesine `database.rules.json` içeriğini yapıştırıp **Publish** edin (veya `firebase deploy --only database`).

### 2. Statik Yayınlama (GitHub Pages)
Proje build gerektirmez; `main` dalından GitHub Pages üzerinden doğrudan yayınlanabilir.

### 3. (Opsiyonel) Cloudflare Worker — TURN + Güvenli Telegram Proxy
Mobil veride (4G/5G CGNAT) her zaman bağlanmak ve Telegram Bot Token'ını tarayıcı yerine sunucuda saklamak için:

```bash
cd worker
npx wrangler login
npx wrangler secret put FIREBASE_WEB_API_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put CF_TURN_KEY_ID
npx wrangler secret put CF_TURN_API_TOKEN
# (Opsiyonel) Yalnızca belirli Firebase kullanıcılarına izin vermek için:
# npx wrangler secret put ALLOWED_UIDS
npx wrangler deploy
```

Deploy sonrası oluşan `https://securitycam-proxy.<hesabiniz>.workers.dev` adresini uygulamadaki **Kurulum → Gelişmiş Ağ, TURN & Telegram Proxy Ayarları** bölümüne yapıştırıp **Kaydet** ve **ICE / TURN Test Et** butonlarıyla doğrulayın.
