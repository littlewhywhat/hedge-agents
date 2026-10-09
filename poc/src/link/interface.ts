export type Handler<Req, Res> = (request: Req) => Promise<Res>;

export type Server<Push> = {
  broadcast(message: Push): void;
  close(): Promise<void>;
};

export type Peer<Req, Res, Push> = {
  request(message: Req, timeoutMs?: number): Promise<Res>;
  onPush(listener: (message: Push) => void): void;
  connected(): boolean;
  close(): void;
};
