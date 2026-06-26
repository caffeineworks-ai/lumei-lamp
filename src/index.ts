import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ─── 타입 정의 ───────────────────────────────────────────────────────────────

interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  LUMEI_KV: KVNamespace;
}

type LightMode = "focus" | "relax" | "night";

interface LampState {
  power: boolean;         // 전원 ON/OFF
  brightness: number;     // 밝기 0~100
  mode: LightMode | null; // 조명 모드
  tracking: boolean;      // 물체 추적 ON/OFF
  battery: number;        // 배터리 잔량 0~100
  message: string;        // Push Messages에 표시할 메시지
  updatedAt: string;      // ISO 타임스탬프
}

const MODE_COLOR: Record<LightMode, string> = {
  focus: "#FFB780",
  relax: "#FFFEE7",
  night: "#FFB74D",
};

const MODE_DESC: Record<LightMode, string> = {
  focus: "집중 모드 — 쿨 화이트 계열, 작업에 최적",
  relax: "휴식 모드 — 따뜻한 아이보리, 눈 편안",
  night: "취침 모드 — 낮은 색온도 앰버, 수면 유도",
};

const DEFAULT_STATE: LampState = {
  power: false,
  brightness: 50,
  mode: null,
  tracking: false,
  battery: 98,
  message: "",
  updatedAt: new Date().toISOString(),
};

// ─── MCP Agent ────────────────────────────────────────────────────────────────

export class LumeiMCP extends McpAgent {
  server = new McpServer({ name: "lumei-lamp", version: "1.0.0" });

  get kv(): KVNamespace {
    return (this.env as Env).LUMEI_KV;
  }

  async getState(): Promise<LampState> {
    const raw = await this.kv.get("state");
    if (!raw) return { ...DEFAULT_STATE };
    return JSON.parse(raw) as LampState;
  }

  async setState(patch: Partial<LampState>): Promise<LampState> {
    const current = await this.getState();
    const next: LampState = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await this.kv.put("state", JSON.stringify(next));
    return next;
  }

  async init() {

    // ── 0. 제품 정보 ─────────────────────────────────────────────────────────
    const VIRTUAL_DEVICE_URL =
      "https://YOUR_GITHUB_USER.github.io/lumei/lumei_virtual.html"; // ✏️ 교체

    this.server.tool(
      "get_product_info",
      "LUMEI 조명의 제품 소개, 기능, 스펙 등 기본 정보를 반환합니다.",
      {},
      async () => {
        try {
          const res = await fetch(VIRTUAL_DEVICE_URL);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const html = await res.text();
          const match = html.match(
            /<script[^>]+id="product-info"[^>]*>([\s\S]*?)<\/script>/
          );
          if (!match) throw new Error("product-info block not found");

          const info = JSON.parse(match[1].trim()) as {
            name: string; tagline: string; description: string;
            features: string[]; spec?: Record<string, string>;
          };

          const lines = [`■ ${info.name}`, info.tagline, "", info.description];
          if (info.features?.length) {
            lines.push("", "주요 기능:");
            info.features.forEach(f => lines.push(`  • ${f}`));
          }
          if (info.spec) {
            const entries = Object.entries(info.spec).filter(([, v]) => v && !v.startsWith("TODO"));
            if (entries.length) {
              lines.push("", "스펙:");
              entries.forEach(([k, v]) => lines.push(`  • ${k}: ${v}`));
            }
          }
          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch {
          return { content: [{ type: "text", text: "[제품 정보를 불러올 수 없습니다]\nVIRTUAL_DEVICE_URL을 올바른 GitHub Pages 주소로 설정하세요." }] };
        }
      }
    );

    // ── 1. 상태 조회 ─────────────────────────────────────────────────────────
    this.server.tool(
      "get_lamp_state",
      "LUMEI 조명의 현재 상태(전원·밝기·색온도·모드·배터리·추적 여부)를 조회합니다.",
      {},
      async () => {
        const s = await this.getState();
        const modeStr = s.mode
          ? `${s.mode.toUpperCase()} (${MODE_COLOR[s.mode]}) — ${MODE_DESC[s.mode]}`
          : "없음";
        const text = [
          `전원: ${s.power ? "ON" : "OFF"}`,
          `밝기: ${s.brightness}%`,
          `모드: ${modeStr}`,
          `물체 추적: ${s.tracking ? "활성화" : "비활성화"}`,
          `배터리: ${s.battery}%`,
          `마지막 변경: ${s.updatedAt}`,
        ].join("\n");
        return { content: [{ type: "text", text }] };
      }
    );

    // ── 2. 전원 제어 ─────────────────────────────────────────────────────────
    this.server.tool(
      "set_power",
      "LUMEI 조명의 전원을 켜거나 끕니다. 전원을 끄면 추적도 자동으로 중지됩니다.",
      { on: z.boolean().describe("true = 전원 ON, false = 전원 OFF") },
      async ({ on }) => {
        const patch: Partial<LampState> = { power: on };
        if (!on) patch.tracking = false;
        patch.message = on ? "조명이 켜졌습니다." : "조명이 꺼졌습니다.";
        await this.setState(patch);
        return { content: [{ type: "text", text: patch.message as string }] };
      }
    );

    // ── 3. 밝기 설정 ─────────────────────────────────────────────────────────
    this.server.tool(
      "set_brightness",
      "LUMEI 조명의 밝기를 설정합니다. 0(소등)~100(최대) 사이의 정수를 입력하세요.",
      { brightness: z.number().int().min(0).max(100).describe("밝기 값 (0~100)") },
      async ({ brightness }) => {
        const s = await this.getState();
        if (!s.power) {
          return { content: [{ type: "text", text: "전원이 꺼져 있어 밝기를 조절할 수 없습니다. 먼저 전원을 켜주세요." }] };
        }
        const msg = `밝기를 ${brightness}%로 설정했습니다.`;
        await this.setState({ brightness, message: msg });
        return { content: [{ type: "text", text: msg }] };
      }
    );

    // ── 4. 모드 설정 ─────────────────────────────────────────────────────────
    this.server.tool(
      "set_mode",
      `조명 모드를 변경합니다. 사용 가능한 모드: focus(집중 #FFB780) / relax(휴식 #FFFEE7) / night(취침 #FFB74D)`,
      { mode: z.enum(["focus", "relax", "night"]).describe("조명 모드") },
      async ({ mode }) => {
        const s = await this.getState();
        if (!s.power) {
          return { content: [{ type: "text", text: "전원이 꺼져 있어 모드를 변경할 수 없습니다. 먼저 전원을 켜주세요." }] };
        }
        const msg = `${mode.toUpperCase()} 모드로 변경했습니다. ${MODE_DESC[mode]}`;
        await this.setState({ mode, message: msg });
        return { content: [{ type: "text", text: msg }] };
      }
    );

    // ── 5. 물체 추적 제어 ────────────────────────────────────────────────────
    this.server.tool(
      "set_tracking",
      "LUMEI의 물체 추적 기능을 켜거나 끕니다. 램프 암의 센서와 액추에이터가 특정 물체를 자동으로 따라가며 조명을 비춥니다.",
      { on: z.boolean().describe("true = 추적 ON, false = 추적 OFF") },
      async ({ on }) => {
        const s = await this.getState();
        if (!s.power && on) {
          return { content: [{ type: "text", text: "전원이 꺼져 있어 추적을 시작할 수 없습니다. 먼저 전원을 켜주세요." }] };
        }
        const msg = on
          ? "물체 추적을 시작합니다. 센서가 피사체를 감지하면 자동으로 조명을 향합니다."
          : "물체 추적을 중지합니다.";
        await this.setState({ tracking: on, message: msg });
        return { content: [{ type: "text", text: msg }] };
      }
    );

    // ── 6. 배터리 조회 ───────────────────────────────────────────────────────
    this.server.tool(
      "get_charging_state",
      "LUMEI의 현재 배터리 잔량을 조회합니다.",
      {},
      async () => {
        const s = await this.getState();
        const bar = "█".repeat(Math.round(s.battery / 10)) + "░".repeat(10 - Math.round(s.battery / 10));
        const text = `배터리 잔량: ${s.battery}%\n[${bar}]`;
        return { content: [{ type: "text", text }] };
      }
    );

    // ── 7. 메시지 전송 ───────────────────────────────────────────────────────
    this.server.tool(
      "send_message",
      "LUMEI 가상 기기의 Push Messages 패널에 메시지를 표시합니다.",
      { message: z.string().min(1).max(200).describe("기기에 표시할 메시지") },
      async ({ message }) => {
        await this.setState({ message });
        return { content: [{ type: "text", text: `메시지를 전송했습니다: "${message}"` }] };
      }
    );
  }
}

// ─── Fetch Handler ────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/mcp") {
      return LumeiMCP.serve("/mcp").fetch(request, env, ctx);
    }

    // 가상 기기 폴링 엔드포인트
    if (url.pathname === "/state") {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          },
        });
      }

      // POST: 가상 기기에서 상태 패치
      if (request.method === "POST") {
        try {
          const patch = await request.json() as Partial<LampState>;
          const raw = await env.LUMEI_KV.get("state");
          const current = raw ? JSON.parse(raw) : { power: false, brightness: 50, mode: null, tracking: false, battery: 98, message: "", updatedAt: "" };
          const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
          await env.LUMEI_KV.put("state", JSON.stringify(next));
          return new Response(JSON.stringify(next), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        } catch {
          return new Response("Bad Request", { status: 400 });
        }
      }

      // GET: 현재 상태 반환
      const raw = await env.LUMEI_KV.get("state");
      return new Response(raw ?? "{}", {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
