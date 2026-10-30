/* 우리의 자산 — 서비스워커
 * 앱 껍데기(app shell)를 캐시해 오프라인에서도 열리게 하고,
 * 온라인일 때는 항상 최신 index.html 을 먼저 받아옵니다.
 * 파일을 수정하면 아래 CACHE 버전을 올려 주세요. (예: v1 -> v2)
 */
const CACHE = 'ourassets-v560';

/* Web Share Target(manifest.webmanifest의 share_target)으로 OS 공유 시트에서 넘어온 영수증
 * 사진을 index.html이 읽어갈 때까지 잠깐 보관하는 전용 캐시. CACHE(앱 쉘)와 이름을 분리해
 * 아래 activate가 구버전 캐시를 정리할 때 함께 지워지지 않게 한다 — 공유 직후 SW가 업데이트되는
 * 드문 타이밍에도 막 받은 사진이 날아가지 않도록(app-evolve cycle264 advance). */
const SHARE_CACHE = 'ourassets-share-inbox';
const SHARE_PHOTO_KEY = './__shared-photo__';

const SHELL = [
  './',
  './index.html',
  './logic.js',
  './manifest.webmanifest',
  './favicon.ico',
  './favicon-32.png',
  './favicon-16.png',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== SHARE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* OS 공유 시트(사진 앱/카메라/은행 앱 등)가 manifest의 share_target으로 보낸 POST를 받아
 * 파일을 SHARE_CACHE에 고정 키로 저장하고, index.html의 runShortcutAction('shareReceipt')가
 * 받도록 ?action=shareReceipt로 리다이렉트한다(app-evolve cycle264 advance). 303으로 응답해야
 * 브라우저가 POST가 아닌 GET으로 리다이렉트를 따라간다. */
async function handleShareReceipt(req) {
  try {
    const formData = await req.formData();
    const file = formData.get('photo');
    if (file && typeof file.size === 'number' && file.size > 0) {
      const cache = await caches.open(SHARE_CACHE);
      await cache.put(SHARE_PHOTO_KEY, new Response(file, { headers: { 'Content-Type': file.type || 'image/jpeg' } }));
    }
  } catch (e) {}
  return Response.redirect('./?action=shareReceipt', 303);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  if (req.method === 'POST' && url.origin === self.location.origin && url.pathname.endsWith('/share-receipt')) {
    e.respondWith(handleShareReceipt(req));
    return;
  }

  if (req.method !== 'GET') return;

  // 다른 도메인(카카오 SDK, 폰트 CDN 등)은 가로채지 않고 네트워크로 직접 보냅니다.
  if (url.origin !== self.location.origin) return;

  // 시세 중계 함수는 항상 네트워크에서 최신값을 받아야 하므로 캐시하지 않습니다.
  if (url.pathname.startsWith('/.netlify/functions/')) return;

  // 페이지 이동 요청: 네트워크 우선, 실패 시 캐시된 index.html 로 폴백(오프라인 지원)
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          // 배포 중 일시적인 서버 오류(502/503)나 호스팅의 커스텀 404 응답까지 그대로
          // 캐시하면, 그 뒤 오프라인 폴백이 "마지막으로 받은 정상 페이지"가 아니라
          // 그 오류 페이지를 돌려주게 된다(app-evolve cycle226) — 아래 정적 리소스 분기와
          // 동일하게 status===200인 정상 응답만 캐시에 반영한다.
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('./index.html', copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  // 그 외 같은 도메인 정적 리소스: 캐시 우선, 없으면 네트워크에서 받아 캐시에 저장
  e.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      });
    })
  );
});

// 홈 알림(이체 확인/저축 만기/예산 초과) OS 알림을 탭하면 앱 창을 포커스하거나(없으면) 새로 연다.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});
