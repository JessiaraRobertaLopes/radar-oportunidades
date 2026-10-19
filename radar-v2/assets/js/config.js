/* =====================================================================
   CONFIGURAÇÃO DO AMBIENTE
   Único arquivo que muda na migração para o ambiente oficial.
   - SUPABASE_URL: Project Settings > API > Project URL
   - SUPABASE_PUBLISHABLE_KEY: Project Settings > API Keys > Publishable key
     (chave pública; a segurança dos dados é garantida pelo RLS do banco)
   NUNCA colocar aqui a chave service_role nem a chave da Anthropic.
   ===================================================================== */
window.RADAR_CONFIG = {
  SUPABASE_URL: 'https://ovedkeyvqzuomhkqepca.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_J3_bfzs_OaAxqTPRJG8TVg_7TWJKjYM',
  DOMINIO_PERMITIDO: 'santacasabh.org.br',
  NOME_SISTEMA: 'Radar de Oportunidades',
  VERSAO: '2.0'
};
