export async function createRoom() {
  const base = window.location.origin;
  const res = await fetch(`${base}/api/rooms`, { method: "POST" });
  if (!res.ok) throw new Error("创建房间失败");
  return res.json();
}
