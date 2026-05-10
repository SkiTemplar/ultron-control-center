# AUDIT FLAGS - 2026-05-02

## Skills que requieren revisión por cambios en el ecosistema (Triggered by ULTRON Times)

### Skill: `ultron`
- **claude_code_update**: Nueva versión 2.1.126 de Claude Code. Introduce "Project Purge" y selección de modelo inteligente. 
- **mcp_v2**: Claude Code ahora soporta invocar herramientas MCP directamente desde hooks. La skill `ultron` debería actualizarse para aprovechar esta capacidad de conectar escáneres/scripts empresariales en el flujo.
- **gemini_cli_rce**: Vulnerabilidad Crítica (CVSS 10.0) en `@google/gemini-cli`. **ACCIÓN INMEDIATA REQUERIDA**: Actualizar el paquete npm de Gemini CLI en nuestro entorno local/CI para parchear la vulnerabilidad de inyección en configuración.

### Skill: `terry-davis`
- **github_copilot_tokens**: El modelo de suscripción de GitHub Copilot cambia a facturación por tokens ("AI Credits"). La skill `terry-davis` debería estar al tanto para optimizar los prompts o flujos si interviene en configuraciones de Copilot, evitando consumos excesivos involuntarios en sesiones autónomas (Agent Mode).
