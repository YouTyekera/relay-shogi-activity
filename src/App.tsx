import { useState } from "react";
import RelayShogiApp from "./games/relay/RelayShogiApp";
import ThreeShogiApp from "./games/three/ThreeShogiApp";

type GameMode = "menu" | "relay" | "three";

export default function App() {
  const [mode, setMode] = useState<GameMode>("menu");

  if (mode === "relay") {
    return <RelayShogiApp />;
  }

  if (mode === "three") {
    return <ThreeShogiApp />;
  }

  return (
    <div style={pageStyle}>
      <div style={heroStyle}>
        <div>
          <div style={badgeStyle}>Discord Activity</div>
          <h1 style={titleStyle}>将棋アクティビティ</h1>
          <p style={leadStyle}>
            チームで遊ぶリレー将棋と、三勢力で中央を奪い合う三人将棋を選べます。
          </p>
        </div>
      </div>

      <div style={cardGridStyle}>
        <button style={gameCardStyle} onClick={() => setMode("relay")}>
          <div style={cardTitleStyle}>リレー将棋</div>
          <div style={cardTextStyle}>
            先手・後手のチームに分かれて、順番に一手ずつ指します。
          </div>
          <div style={cardMetaStyle}>チーム戦 / 通常将棋 / 感想戦</div>
        </button>

        <button style={gameCardStyle} onClick={() => setMode("three")}>
          <div style={cardTitleStyle}>三人将棋</div>
          <div style={cardTextStyle}>
            赤軍・青軍・緑軍で戦う三人用将棋です。中央制圧でも勝利できます。
          </div>
          <div style={cardMetaStyle}>三勢力 / 中央制圧 / 持ち駒</div>
        </button>
      </div>
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  boxSizing: "border-box",
  padding: "clamp(20px, 4vw, 56px)",
  background:
    "radial-gradient(circle at top, #1f2937 0%, #0d1117 45%, #010409 100%)",
  color: "#f0f6fc",
  fontFamily: "system-ui, sans-serif",
};

const heroStyle: React.CSSProperties = {
  maxWidth: 960,
  margin: "0 auto 28px",
  padding: "clamp(18px, 4vw, 40px)",
  border: "1px solid #30363d",
  borderRadius: 24,
  background: "rgba(1, 4, 9, 0.72)",
  boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
};

const badgeStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "6px 10px",
  borderRadius: 999,
  background: "#1f6feb",
  color: "white",
  fontSize: 13,
  fontWeight: 800,
  marginBottom: 14,
};

const titleStyle: React.CSSProperties = {
  fontSize: "clamp(34px, 7vw, 72px)",
  margin: 0,
  letterSpacing: "-0.04em",
};

const leadStyle: React.CSSProperties = {
  fontSize: "clamp(15px, 2vw, 20px)",
  color: "#c9d1d9",
  lineHeight: 1.8,
  maxWidth: 760,
};

const cardGridStyle: React.CSSProperties = {
  maxWidth: 960,
  margin: "0 auto",
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
  gap: 18,
};

const gameCardStyle: React.CSSProperties = {
  textAlign: "left",
  border: "1px solid #30363d",
  borderRadius: 20,
  padding: 24,
  background: "linear-gradient(145deg, #161b22, #0d1117)",
  color: "#f0f6fc",
  cursor: "pointer",
  minHeight: 190,
  boxShadow: "0 14px 40px rgba(0,0,0,0.24)",
};

const cardTitleStyle: React.CSSProperties = {
  fontSize: 28,
  fontWeight: 900,
  marginBottom: 12,
};

const cardTextStyle: React.CSSProperties = {
  color: "#c9d1d9",
  lineHeight: 1.7,
  fontSize: 15,
  marginBottom: 18,
};

const cardMetaStyle: React.CSSProperties = {
  color: "#58a6ff",
  fontWeight: 800,
  fontSize: 13,
};