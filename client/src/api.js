const API_BASE = ((import.meta.env.VITE_API_BASE || "").trim() || window.location.origin).replace(/\/$/, "");

export async function createRoom() {
  const res = await fetch(`${API_BASE}/api/rooms`, { method: "POST" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || "创建房间失败");
  return data;
}

export async function fetchRooms() {
  const res = await fetch(`${API_BASE}/api/rooms/list`);
  if (!res.ok) throw new Error("获取房间列表失败");
  return res.json();
}
