import Image from "next/image";
import { Coins, Landmark, Wallet } from "lucide-react";

export const markets: Record<string, { name: string; symbol: string; color: string }> = {
  btc: { name: "Bitcoin", symbol: "cbBTC", color: "#e79a39" },
  eth: { name: "Ethereum", symbol: "WETH", color: "#6486d7" },
  stocks: { name: "S&P 500", symbol: "SPYx", color: "#379b81" },
  gold: { name: "Gold", symbol: "PAXG", color: "#b5a344" },
};

export function Avatar({ agent, small = false }: { agent: string; small?: boolean }) {
  return <span className={`avatar ${small ? "small" : ""}`} style={{ background: `${markets[agent]?.color || "#888"}15`, color: markets[agent]?.color }}>
    {agent === "btc" || agent === "eth" ? <Image src={`/assets/${agent}.png`} alt="" width={small ? 22 : 28} height={small ? 22 : 28} /> : agent === "gold" ? <Coins size={small ? 18 : 22} /> : <Landmark size={small ? 18 : 22} />}
  </span>;
}

export function Empty({ icon: Icon = Wallet, heading, text }: { icon?: typeof Wallet; heading: string; text: string }) {
  return <div className="empty"><span className="empty-icon"><Icon size={26} strokeWidth={1.5} /></span><h3>{heading}</h3><p>{text}</p></div>;
}

export function Pill({ children, tone = "neutral" }: { children: React.ReactNode; tone?: string }) {
  return <span className={`pill ${tone}`}><span className="status-dot" />{children}</span>;
}
