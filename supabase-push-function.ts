// НЕ ШКОЛА CRM — Edge Function: отправка push-уведомления на устройство.
//
// Это не разворачивается автоматически из этого архива — Supabase Edge
// Functions создаются и разворачиваются через панель Supabase (или CLI),
// файлом это никак нельзя "залить" как обычный сайт. Инструкция — в
// push-setup-instructions.md рядом с этим файлом.
//
// Deno (среда Supabase Edge Functions) поддерживает импорт npm-пакетов
// напрямую через префикс "npm:".

import webpush from "npm:web-push@3.6.7";

const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

webpush.setVapidDetails(
  "mailto:support@example.com",
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

Deno.serve(async (req) => {
  try {
    const payload = await req.json();
    // Формат, который присылает Database Webhook при INSERT в notifications:
    // { type: "INSERT", table: "notifications", record: { user_id, type, message, ... } }
    const record = payload.record || payload;
    const userId = record.user_id;
    const message = record.message || "Новое уведомление";

    if (!userId) {
      return new Response(JSON.stringify({ error: "no user_id" }), { status: 400 });
    }

    // Забираем все подписки этого пользователя напрямую через REST API
    // (service role key — обходит RLS, что здесь и нужно серверной функции)
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/push_subscriptions?user_id=eq.${userId}&select=*`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    const subs = await res.json();

    const results = await Promise.allSettled(
      (subs || []).map((sub: any) =>
        webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          JSON.stringify({ title: "Моя школа", body: message })
        )
      )
    );

    return new Response(JSON.stringify({ sent: results.length }), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
