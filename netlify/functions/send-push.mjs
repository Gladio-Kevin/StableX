import { createClient } from "@supabase/supabase-js";
import webpush from "web-push";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
const vapidSubject = process.env.VAPID_SUBJECT;

const admin = createClient(supabaseUrl, serviceRoleKey);

webpush.setVapidDetails(
  vapidSubject,
  vapidPublicKey,
  vapidPrivateKey
);

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const authorization = req.headers.get("authorization") || "";
    const token = authorization.replace(/^Bearer\s+/i, "");

    if (!token) {
      return Response.json(
        { error: "Oturum doğrulanamadı." },
        { status: 401 }
      );
    }

    const authClient = createClient(
      supabaseUrl,
      supabaseAnonKey
    );

    const {
      data: { user },
      error: authError
    } = await authClient.auth.getUser(token);

    if (authError || !user) {
      return Response.json(
        { error: "Geçersiz oturum." },
        { status: 401 }
      );
    }

    const { type, message_id } = await req.json();

    if (!["private", "group"].includes(type) || !message_id) {
      return Response.json(
        { error: "Geçersiz istek." },
        { status: 400 }
      );
    }

    let recipients = [];
    let message;

    if (type === "private") {
      const { data, error } = await admin
        .from("messages")
        .select("id,sender_id,receiver_id,content")
        .eq("id", message_id)
        .single();

      if (error || !data || data.sender_id !== user.id) {
        return Response.json(
          { error: "Mesaj bulunamadı veya yetkiniz yok." },
          { status: 403 }
        );
      }

      message = data;
      recipients = [data.receiver_id];
    }

    if (type === "group") {
      const { data, error } = await admin
        .from("group_messages")
        .select("id,group_id,sender_id,content")
        .eq("id", message_id)
        .single();

      if (error || !data || data.sender_id !== user.id) {
        return Response.json(
          { error: "Mesaj bulunamadı veya yetkiniz yok." },
          { status: 403 }
        );
      }

      message = data;

      const { data: members, error: membersError } = await admin
        .from("group_members")
        .select("user_id")
        .eq("group_id", data.group_id);

      if (membersError) throw membersError;

      recipients = (members || [])
        .map(member => member.user_id);
    }

    recipients = [...new Set(recipients)]
      .filter(id => id && id !== user.id);

    if (recipients.length === 0) {
      return Response.json({ success: true, sent: 0 });
    }

    const { data: subscriptions, error: subscriptionError } =
      await admin
        .from("push_subscriptions")
        .select("user_id,endpoint,p256dh,auth")
        .in("user_id", recipients);

    if (subscriptionError) throw subscriptionError;

    const payload = JSON.stringify({
      title: "StableX",
      body: message.content || "Yeni bir mesajın var.",
      url: "/",
      tag: `${type}-${message.id}`
    });

    let sent = 0;

    for (const sub of subscriptions || []) {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: {
              p256dh: sub.p256dh,
              auth: sub.auth
            }
          },
          payload
        );

        sent++;
      } catch (error) {
        console.error("Push gönderim hatası:", error);

        if (error.statusCode === 404 || error.statusCode === 410) {
          await admin
            .from("push_subscriptions")
            .delete()
            .eq("endpoint", sub.endpoint);
        }
      }
    }

    return Response.json({
      success: true,
      sent
    });

  } catch (error) {
    console.error("StableX Push Function:", error);

    return Response.json(
      { error: "Bildirim gönderilirken hata oluştu." },
      { status: 500 }
    );
  }
};
