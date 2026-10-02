-- 364_ROLLBACK_transport_coverage_snaider_tacuarendi.sql

DELETE FROM public.transport_coverage
 WHERE source = 'snaider'
   AND provincia = 'Santa Fe'
   AND localidad IN ('Tacuarendi', 'Tacuarendi (Emb. Kilometro 421)');
