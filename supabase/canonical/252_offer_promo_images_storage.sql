-- 252_offer_promo_images_storage.sql
-- Buckets públicos para imágenes de ofertas por color y promociones 2x.
-- El admin NO puede crear buckets desde el browser (RLS en storage.buckets).
-- Idempotente.

-- ---------------------------------------------------------------------------
-- 1) Buckets públicos
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  (
    'offer-images',
    'offer-images',
    true,
    10485760,
    array['image/jpeg', 'image/png', 'image/webp', 'image/jpg']
  ),
  (
    'promo-images',
    'promo-images',
    true,
    10485760,
    array['image/jpeg', 'image/png', 'image/webp', 'image/jpg']
  )
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- 2) Policies storage.objects — lectura pública + escritura admin
-- ---------------------------------------------------------------------------
do $$
begin
  -- offer-images: public read
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'offer_images_public_select'
  ) then
    create policy offer_images_public_select
      on storage.objects
      for select
      to anon, authenticated
      using (bucket_id = 'offer-images');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'offer_images_admin_insert'
  ) then
    create policy offer_images_admin_insert
      on storage.objects
      for insert
      to authenticated
      with check (
        bucket_id = 'offer-images'
        and exists (select 1 from public.admins a where a.user_id = auth.uid())
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'offer_images_admin_update'
  ) then
    create policy offer_images_admin_update
      on storage.objects
      for update
      to authenticated
      using (
        bucket_id = 'offer-images'
        and exists (select 1 from public.admins a where a.user_id = auth.uid())
      )
      with check (
        bucket_id = 'offer-images'
        and exists (select 1 from public.admins a where a.user_id = auth.uid())
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'offer_images_admin_delete'
  ) then
    create policy offer_images_admin_delete
      on storage.objects
      for delete
      to authenticated
      using (
        bucket_id = 'offer-images'
        and exists (select 1 from public.admins a where a.user_id = auth.uid())
      );
  end if;

  -- promo-images: public read
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'promo_images_public_select'
  ) then
    create policy promo_images_public_select
      on storage.objects
      for select
      to anon, authenticated
      using (bucket_id = 'promo-images');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'promo_images_admin_insert'
  ) then
    create policy promo_images_admin_insert
      on storage.objects
      for insert
      to authenticated
      with check (
        bucket_id = 'promo-images'
        and exists (select 1 from public.admins a where a.user_id = auth.uid())
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'promo_images_admin_update'
  ) then
    create policy promo_images_admin_update
      on storage.objects
      for update
      to authenticated
      using (
        bucket_id = 'promo-images'
        and exists (select 1 from public.admins a where a.user_id = auth.uid())
      )
      with check (
        bucket_id = 'promo-images'
        and exists (select 1 from public.admins a where a.user_id = auth.uid())
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'promo_images_admin_delete'
  ) then
    create policy promo_images_admin_delete
      on storage.objects
      for delete
      to authenticated
      using (
        bucket_id = 'promo-images'
        and exists (select 1 from public.admins a where a.user_id = auth.uid())
      );
  end if;
end $$;

select pg_notify('pgrst', 'reload schema');
