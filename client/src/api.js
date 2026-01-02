const API_BASE = ((import.meta.env.VITE_API_BASE || "").trim() || window.location.origin).replace(/\/$/, "");

export async function createRoom() {
  const res = await fetch(`${API_BASE}/api/rooms`, { method: "POST" });
  if (!res.ok) throw new Error("创建房间失败");
  return res.json();
}

export async function fetchSoloRooms() {
  const res = await fetch(`${API_BASE}/api/rooms/solo`);
  if (!res.ok) throw new Error("获取房间列表失败");
  return res.json();
}
