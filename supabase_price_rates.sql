-- ============================================================
-- 药物详情「各价格独立倍率」所需的两个列（可选执行）
-- 在 Supabase → SQL Editor 里整段跑一次即可，可重复执行（IF NOT EXISTS）。
--
-- 不执行也能用：批发价与各价格倍率会只存本机（localStorage）。
-- 执行后应用启动时探测到这两列存在，才会把它们一起同步到云端。
-- 应用对缺列的兼容见 index.html 里的 SUPA.probeExt()。
-- ============================================================

alter table public.drugs add column if not exists wp    numeric;   -- 批发价（元/kg）
alter table public.drugs add column if not exists rates jsonb;     -- 各价格倍率 {p: 零售倍率, wp: 批发倍率}

comment on column public.drugs.wp    is '批发价，元/kg；= 进货价(cost, 元/kg) × rates.wp';
comment on column public.drugs.rates is '各价格独立倍率：{"p":零售倍率,"wp":批发倍率}；零售价 = cost × rates.p ÷ 1000';

-- ------------------------------------------------------------
-- 关于「按 user_id 做 RLS 隔离」：
-- 本应用是纯静态页 + publishable anon key 直连，没有接入 Supabase Auth，
-- 请求里不带用户身份。此时若给 drugs / doctors / prescriptions 加
--   using (user_id = auth.uid())
-- 会让所有请求因为 auth.uid() 为 null 而全部读不到数据，等于把应用打死。
-- 正确顺序是：先接入 Auth（登录）→ 表里加 user_id 并回填 → 再开 RLS 策略。
-- 在那之前保持现状（anon 可读写），不要单加策略。
-- ------------------------------------------------------------
