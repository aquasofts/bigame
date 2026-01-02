import { io } from "socket.io-client";

export function makeSocket() {
  const base = ((import.meta.env.VITE_SOCKET_URL || "").trim() || window.location.origin).replace(/\/$/, "");
  return io(base, { withCredentials: true, transports: ["polling", "websocket"] });
}
