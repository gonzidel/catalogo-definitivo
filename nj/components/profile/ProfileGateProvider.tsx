"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { isInitialProfileComplete } from "@/lib/auth/profile-complete";
import ProfileOnboardingModal from "@/components/profile/ProfileOnboardingModal";

type ProfileGateContextValue = {
  /** null = aún no sabemos / sin sesión evaluada */
  profileComplete: boolean | null;
  isLoggedIn: boolean;
  /**
   * Si el usuario está logueado y el perfil está incompleto, abre el modal
   * y resuelve `true` al completar. Invitados (sin sesión) → `true`.
   */
  requireProfileComplete: () => Promise<boolean>;
  refreshProfileCompleteness: () => Promise<boolean>;
  /**
   * Sube cada vez que el onboarding guarda el perfil. Los consumidores
   * (ej. Dashboard) pueden refetchear el customer sin esperar un F5.
   */
  profileUpdatedAt: number;
};

const ProfileGateContext = createContext<ProfileGateContextValue | null>(null);

export function useProfileGate(): ProfileGateContextValue {
  const ctx = useContext(ProfileGateContext);
  if (!ctx) {
    throw new Error("useProfileGate debe usarse dentro de ProfileGateProvider");
  }
  return ctx;
}

/** Versión segura para componentes que pueden montarse fuera del provider. */
export function useProfileGateOptional(): ProfileGateContextValue | null {
  return useContext(ProfileGateContext);
}

export default function ProfileGateProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [profileComplete, setProfileComplete] = useState<boolean | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [profileUpdatedAt, setProfileUpdatedAt] = useState(0);
  const pendingRef = useRef<((ok: boolean) => void) | null>(null);

  const loadCompleteness = useCallback(async (uid: string): Promise<boolean> => {
    const supabase = getSupabaseBrowserClient();
    const { data: customer } = await supabase
      .from("customers")
      .select("full_name, phone, dni, province, city, address")
      .eq("id", uid)
      .maybeSingle();
    const ok = isInitialProfileComplete(customer);
    setProfileComplete(ok);
    return ok;
  }, []);

  const refreshProfileCompleteness = useCallback(async () => {
    if (!userId) {
      setProfileComplete(null);
      return true;
    }
    return loadCompleteness(userId);
  }, [userId, loadCompleteness]);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    let cancelled = false;

    async function applySession(session: {
      user: {
        id: string;
        email?: string | null;
        user_metadata?: Record<string, string>;
      };
    } | null) {
      if (cancelled) return;
      if (!session?.user) {
        setUserId(null);
        setEmail("");
        setProfileComplete(null);
        setModalOpen(false);
        pendingRef.current?.(false);
        pendingRef.current = null;
        return;
      }
      setUserId(session.user.id);
      setEmail(session.user.email ?? "");
      const ok = await loadCompleteness(session.user.id);
      if (cancelled) return;
      // Post-login: forzar modal si falta perfil (Google / magic link).
      if (!ok) setModalOpen(true);
    }

    void supabase.auth.getSession().then(({ data }) => {
      void applySession(data.session);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      void applySession(session);
    });

    return () => {
      cancelled = true;
      listener.subscription.unsubscribe();
    };
  }, [loadCompleteness]);

  const requireProfileComplete = useCallback(async (): Promise<boolean> => {
    // Invitado: puede armar carrito local.
    if (!userId) return true;

    let ok = profileComplete;
    if (ok === null) {
      ok = await loadCompleteness(userId);
    }
    if (ok) return true;

    setModalOpen(true);
    return new Promise<boolean>((resolve) => {
      pendingRef.current = resolve;
    });
  }, [userId, profileComplete, loadCompleteness]);

  const handleCompleted = useCallback(() => {
    setProfileComplete(true);
    setModalOpen(false);
    setProfileUpdatedAt(Date.now());
    pendingRef.current?.(true);
    pendingRef.current = null;
    router.refresh();
  }, [router]);

  useEffect(() => {
    if (modalOpen && profileComplete === false) {
      document.body.classList.add("modal-open");
      return () => document.body.classList.remove("modal-open");
    }
    document.body.classList.remove("modal-open");
    return undefined;
  }, [modalOpen, profileComplete]);

  const value = useMemo(
    () => ({
      profileComplete,
      isLoggedIn: Boolean(userId),
      requireProfileComplete,
      refreshProfileCompleteness,
      profileUpdatedAt,
    }),
    [
      profileComplete,
      userId,
      requireProfileComplete,
      refreshProfileCompleteness,
      profileUpdatedAt,
    ]
  );

  return (
    <ProfileGateContext.Provider value={value}>
      {children}
      {userId && (
        <ProfileOnboardingModal
          open={modalOpen && profileComplete === false}
          userId={userId}
          email={email}
          onCompleted={handleCompleted}
        />
      )}
    </ProfileGateContext.Provider>
  );
}
