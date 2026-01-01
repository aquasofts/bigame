import { io } from "socket.io-client";

export function makeSocket() {
  const base = window.location.origin;
  return io(base, { withCredentials: true, transports: ["polling", "websocket"] });
}
