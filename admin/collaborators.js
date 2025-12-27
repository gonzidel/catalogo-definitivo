// admin/collaborators.js
import { supabase } from "../scripts/supabase-client.js";
import { isSuperAdmin, requirePermission } from "./permissions-helper.js";

// Verificar que el usuario sea super_admin
async function initCollaborators() {
  const isSuper = await isSuperAdmin();
  if (!isSuper) {
    alert("Solo el administrador principal puede acceder a esta página.");
    window.location.href = "./index.html";
    return;
  }

  setupEventListeners();
  await loadCollaborators();
}

// Esperar a que el DOM esté completamente listo
function waitForDOM() {
  return new Promise((resolve) => {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', resolve);
    } else {
      // Esperar un poco más para asegurar que todos los elementos estén disponibles
      setTimeout(resolve, 100);
    }
  });
}

// Inicializar cuando el DOM esté listo
waitForDOM().then(() => {
  initCollaborators();
});

// Definiciones de permisos disponibles
const PERMISSIONS = [
  { key: 'products', label: 'Productos', description: 'Crear y editar productos y variantes' },
  { key: 'fyl-products', label: 'Productos FYL', description: 'Gestionar stock y visibilidad de productos propios' },
  { key: 'stock', label: 'Stock', description: 'Control de inventario y precios' },
  { key: 'orders', label: 'Pedidos', description: 'Gestionar pedidos pendientes' },
  { key: 'daily-sales', label: 'Ventas Diarias', description: 'Registrar y consultar ventas diarias' },
  { key: 'statistics', label: 'Estadísticas', description: 'KPIs, gráficos y rankings de ventas' },
  { key: 'closed-orders', label: 'Pedidos Cerrados', description: 'Gestionar pedidos cerrados, transporte y rótulos' },
  { key: 'import', label: 'Importar', description: 'Importar datos CSV' },
  { key: 'export', label: 'Exportar', description: 'Exportar datos CSV' },
  { key: 'publications', label: 'Publicaciones', description: 'Gestionar productos para publicar en redes sociales' },
  { key: 'move-stock', label: 'Mover Stock', description: 'Mover productos entre almacenes' },
  { key: 'public-sales', label: 'Venta al público', description: 'Gestionar stock de venta al público' },
  { key: 'offers', label: 'OFERTA', description: 'Gestionar ofertas por color y promociones 2x1/2xMonto' },
  { key: 'search', label: 'Búsqueda', description: 'Búsqueda avanzada de productos y stock' },
  { key: 'labels', label: 'ETIQUETAS', description: 'Imprimir etiquetas para productos' },
  { key: 'customers', label: 'Clientes', description: 'Gestionar clientes y sus datos' },
  { key: 'meta-feed', label: 'Meta (Catálogo)', description: 'Feed CSV para Facebook/Instagram Catalog' }
];

// Configurar event listeners
function setupEventListeners() {
  const form = document.getElementById("add-collaborator-form");
  form?.addEventListener("submit", handleAddCollaborator);
  
  // Mostrar/ocultar campo de contraseña
  const createAccountCheckbox = document.getElementById("create-account");
  const passwordGroup = document.getElementById("password-group");
  const existingUserInfo = document.getElementById("existing-user-info");
  const passwordInput = document.getElementById("collaborator-password");
  
  if (!createAccountCheckbox || !passwordGroup || !existingUserInfo) {
    console.error("Elementos del formulario no encontrados");
    return;
  }
  
  // Configurar estado inicial
  existingUserInfo.style.display = "block";
  
  // Event listener para el checkbox
  createAccountCheckbox.addEventListener("change", function(e) {
    console.log("Checkbox cambiado:", e.target.checked);
    const isChecked = e.target.checked;
    
    if (isChecked) {
      passwordGroup.style.display = "block";
      existingUserInfo.style.display = "none";
      if (passwordInput) {
        passwordInput.required = true;
        passwordInput.focus();
      }
    } else {
      passwordGroup.style.display = "none";
      existingUserInfo.style.display = "block";
      if (passwordInput) {
        passwordInput.required = false;
        passwordInput.value = "";
      }
    }
  });
  
  // También agregar listener con onclick como fallback
  createAccountCheckbox.addEventListener("click", function(e) {
    // Este evento se dispara antes que change, pero lo usamos como respaldo
    setTimeout(() => {
      const isChecked = createAccountCheckbox.checked;
      if (isChecked) {
        passwordGroup.style.display = "block";
        existingUserInfo.style.display = "none";
      } else {
        passwordGroup.style.display = "none";
        existingUserInfo.style.display = "block";
      }
    }, 10);
  });
}

// Cargar lista de colaboradores
async function loadCollaborators() {
  const container = document.getElementById("collaborators-container");
  if (!container) return;

  try {
    container.innerHTML = '<div class="loading">Cargando colaboradores...</div>';

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      container.innerHTML = '<div class="empty-state"><p>No hay sesión activa</p></div>';
      return;
    }

    // Obtener todos los admins
    const { data: admins, error: adminsError } = await supabase
      .from("admins")
      .select("*")
      .order("created_at", { ascending: false });

    if (adminsError) {
      throw adminsError;
    }

    if (!admins || admins.length === 0) {
      container.innerHTML = '<div class="empty-state"><p>No hay colaboradores registrados</p></div>';
      return;
    }

    // Obtener permisos para cada admin
    const adminsWithPermissions = await Promise.all(
      admins.map(async (admin) => {
        const { data: permissions } = await supabase
          .from("admin_permissions")
          .select("*")
          .eq("admin_id", admin.id);

        return {
          ...admin,
          permissions: permissions || []
        };
      })
    );

    // Renderizar lista
    container.innerHTML = '<div class="collaborators-list"></div>';
    const list = container.querySelector(".collaborators-list");

    adminsWithPermissions.forEach(admin => {
      const card = createCollaboratorCard(admin);
      list.appendChild(card);
    });

  } catch (error) {
    console.error("Error cargando colaboradores:", error);
    container.innerHTML = `<div class="message error">Error al cargar colaboradores: ${error.message}</div>`;
  }
}

// Crear tarjeta de colaborador
function createCollaboratorCard(admin) {
  const card = document.createElement("div");
  card.className = "collaborator-card";
  card.dataset.adminId = admin.id;

  const isSuperAdminRole = admin.role === 'super_admin';

  card.innerHTML = `
    <div class="collaborator-header">
      <div class="collaborator-info">
        <h3>${escapeHtml(admin.email)}</h3>
        <p>Creado: ${new Date(admin.created_at).toLocaleDateString('es-AR')}</p>
      </div>
      <div class="actions">
        <span class="role-badge ${admin.role}">${admin.role === 'super_admin' ? 'Super Admin' : 'Colaborador'}</span>
        ${!isSuperAdminRole ? `
          <button class="btn-secondary" onclick="sendPasswordReset('${escapeHtml(admin.email)}')" title="Enviar email para establecer/restablecer contraseña">Establecer Contraseña</button>
          <button class="btn-danger" onclick="deleteCollaborator('${admin.id}', '${escapeHtml(admin.email)}')">Eliminar</button>
        ` : ''}
      </div>
    </div>
    ${!isSuperAdminRole ? `
      <div class="permissions-grid" id="permissions-${admin.id}">
        ${PERMISSIONS.map(perm => {
          const adminPerm = admin.permissions.find(p => p.permission_key === perm.key);
          return `
            <div class="permission-item">
              <h4>${perm.label}</h4>
              <small style="color: #666; display: block; margin-bottom: 8px;">${perm.description}</small>
              <div class="permission-checkboxes">
                <label>
                  <input 
                    type="checkbox" 
                    data-permission="${perm.key}" 
                    data-action="view"
                    ${adminPerm?.can_view ? 'checked' : ''}
                    onchange="updatePermission('${admin.id}', '${perm.key}', 'view', this.checked)"
                  />
                  Ver
                </label>
                <label>
                  <input 
                    type="checkbox" 
                    data-permission="${perm.key}" 
                    data-action="edit"
                    ${adminPerm?.can_edit ? 'checked' : ''}
                    onchange="updatePermission('${admin.id}', '${perm.key}', 'edit', this.checked)"
                  />
                  Editar
                </label>
                <label>
                  <input 
                    type="checkbox" 
                    data-permission="${perm.key}" 
                    data-action="delete"
                    ${adminPerm?.can_delete ? 'checked' : ''}
                    onchange="updatePermission('${admin.id}', '${perm.key}', 'delete', this.checked)"
                  />
                  Eliminar
                </label>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    ` : '<p style="color: #666; margin: 0;">El super administrador tiene todos los permisos.</p>'}
  `;

  return card;
}

// Agregar colaborador
async function handleAddCollaborator(e) {
  e.preventDefault();
  const emailInput = document.getElementById("collaborator-email");
  const passwordInput = document.getElementById("collaborator-password");
  const createAccountCheckbox = document.getElementById("create-account");
  const email = emailInput.value.trim();
  const password = passwordInput?.value || "";
  const createAccount = createAccountCheckbox?.checked || false;
  const btn = document.getElementById("add-collaborator-btn");

  if (!email) {
    showMessage("Por favor ingresa un email válido", "error");
    return;
  }

  if (createAccount && (!password || password.length < 6)) {
    showMessage("La contraseña debe tener al menos 6 caracteres", "error");
    return;
  }

  try {
    btn.disabled = true;
    btn.textContent = createAccount ? "Creando cuenta y agregando..." : "Agregando...";

    const { data: { user: currentUser } } = await supabase.auth.getUser();
    if (!currentUser) {
      throw new Error("No hay sesión activa");
    }

    // Verificar si ya existe como colaborador
    const { data: existing } = await supabase
      .from("admins")
      .select("id")
      .eq("email", email)
      .maybeSingle();

    if (existing) {
      throw new Error("Este colaborador ya está registrado");
    }

    let userId = null;

    if (createAccount) {
      // Guardar el ID del super_admin antes de crear el usuario
      const superAdminId = currentUser.id;
      
      // Intentar primero usar la función RPC que crea el usuario directamente
      // Esto evita problemas de confirmación de email y cambios de sesión
      console.log("Intentando crear colaborador con cuenta nueva usando RPC...");
      const { data: createResult, error: createError } = await supabase
        .rpc('create_collaborator_with_account', {
          p_email: email,
          p_password: password,
          p_created_by_user_id: superAdminId
        });

      if (createError) {
        console.error("Error en create_collaborator_with_account:", createError);
        // Si la función RPC falla, intentar método alternativo con signUp
        console.log("Intentando método alternativo con signUp...");
        
        // Crear cuenta nueva usando signUp
        // Nota: signUp creará el usuario y automáticamente iniciará sesión con él
        const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
          email: email,
          password: password,
          options: {
            emailRedirectTo: `${window.location.origin}/admin/index.html`
          }
        });

        if (signUpError) {
          throw new Error(signUpError.message || "Error al crear la cuenta");
        }

        if (!signUpData?.user) {
          throw new Error("No se pudo crear el usuario");
        }

        userId = signUpData.user.id;

        // Esperar más tiempo para que el usuario se cree completamente en auth.users
        // antes de intentar agregarlo como colaborador
        console.log("Esperando a que el usuario se cree completamente...");
        await new Promise(resolve => setTimeout(resolve, 2000)); // Esperar 2 segundos

        // Usar la función RPC para agregar el colaborador
        const { data: rpcResult, error: rpcError } = await supabase
          .rpc('add_collaborator_to_admins', {
            p_user_id: userId,
            p_email: email,
            p_created_by_user_id: superAdminId
          });

        if (rpcError || !rpcResult || !rpcResult.success) {
          // Si falla, el usuario fue creado pero no se agregó como colaborador
          showMessage(`Usuario ${email} creado exitosamente, pero hubo un error al agregarlo como colaborador: ${rpcResult?.message || rpcError?.message || 'Error desconocido'}. Por favor, vuelve a iniciar sesión y agrégalo manualmente.`, "info");
          setTimeout(() => {
            window.location.reload();
          }, 3000);
          return;
        }

        // Éxito: el colaborador fue creado y agregado
        showMessage(`Colaborador ${email} creado exitosamente. Por favor, vuelve a iniciar sesión para continuar.`, "info");
        setTimeout(() => {
          window.location.reload();
        }, 2000);
        return;
      }

      // Verificar resultado de create_collaborator_with_account
      if (!createResult || !createResult.success) {
        throw new Error(createResult?.message || "Error al crear el colaborador");
      }

      // Éxito: el colaborador fue creado y agregado usando la función RPC
      showMessage(`Colaborador ${email} creado exitosamente.`, "success");
      
      // Limpiar formulario
      emailInput.value = "";
      if (passwordInput) passwordInput.value = "";
      if (createAccountCheckbox) createAccountCheckbox.checked = false;
      document.getElementById("password-group").style.display = "none";
      document.getElementById("existing-user-info").style.display = "block";
      
      await loadCollaborators();
      return;
    } else {
      // Buscar usuario existente primero en customers
      let { data: customer } = await supabase
        .from("customers")
        .select("id")
        .eq("email", email)
        .maybeSingle();

      // Si no está en customers, buscar directamente en auth.users usando la función RPC
      if (!customer) {
        // Usar la función RPC que busca por email en auth.users
        const { data: rpcResult, error: rpcError } = await supabase
          .rpc('add_collaborator_by_email', {
            p_email: email,
            p_created_by_user_id: currentUser.id
          });

        if (rpcError) {
          throw new Error(rpcError.message || "Error al agregar colaborador");
        }

        if (!rpcResult || !rpcResult.success) {
          throw new Error(rpcResult?.message || "Error al agregar colaborador");
        }

        // Si la función RPC tuvo éxito, el colaborador ya fue agregado
        showMessage(`Colaborador ${email} agregado exitosamente`, "success");
        
        // Limpiar formulario
        emailInput.value = "";
        if (passwordInput) passwordInput.value = "";
        if (createAccountCheckbox) createAccountCheckbox.checked = false;
        document.getElementById("password-group").style.display = "none";
        document.getElementById("existing-user-info").style.display = "block";
        
        await loadCollaborators();
        return;
      }

      // Si encontramos el usuario en customers, agregarlo como admin
      if (customer) {
        userId = customer.id;

        // Verificar si ya es admin
        const { data: existingAdmin } = await supabase
          .from("admins")
          .select("id")
          .eq("user_id", userId)
          .maybeSingle();

        if (existingAdmin) {
          throw new Error("Este usuario ya es colaborador");
        }

        // Crear el admin para usuario existente
        const { data: newAdmin, error: createError } = await supabase
          .from("admins")
          .insert({
            user_id: userId,
            email: email,
            role: 'collaborator',
            created_by: currentUser.id
          })
          .select()
          .single();

        if (createError) {
          throw createError;
        }

        showMessage(`Colaborador ${email} agregado exitosamente`, "success");
      } else {
        throw new Error("El usuario no está registrado en el sistema. Marca la opción 'Crear cuenta nueva con contraseña' para crear la cuenta.");
      }
    }

    // Limpiar formulario
    emailInput.value = "";
    if (passwordInput) passwordInput.value = "";
    if (createAccountCheckbox) createAccountCheckbox.checked = false;
    document.getElementById("password-group").style.display = "none";
    document.getElementById("existing-user-info").style.display = "block";

    await loadCollaborators();

  } catch (error) {
    console.error("Error agregando colaborador:", error);
    showMessage(`Error: ${error.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Agregar Colaborador";
  }
}

// Actualizar permiso
window.updatePermission = async function(adminId, permissionKey, action, enabled) {
  try {
    // Obtener el permiso actual
    const { data: existing } = await supabase
      .from("admin_permissions")
      .select("*")
      .eq("admin_id", adminId)
      .eq("permission_key", permissionKey)
      .single();

    const updateData = {};
    if (action === 'view') updateData.can_view = enabled;
    if (action === 'edit') updateData.can_edit = enabled;
    if (action === 'delete') updateData.can_delete = enabled;

    if (existing) {
      // Actualizar permiso existente
      const { error } = await supabase
        .from("admin_permissions")
        .update(updateData)
        .eq("id", existing.id);

      if (error) throw error;
    } else {
      // Crear nuevo permiso
      const { error } = await supabase
        .from("admin_permissions")
        .insert({
          admin_id: adminId,
          permission_key: permissionKey,
          can_view: action === 'view' ? enabled : false,
          can_edit: action === 'edit' ? enabled : false,
          can_delete: action === 'delete' ? enabled : false,
        });

      if (error) throw error;
    }

    showMessage("Permiso actualizado", "success");

  } catch (error) {
    console.error("Error actualizando permiso:", error);
    showMessage(`Error: ${error.message}`, "error");
    // Recargar para revertir cambios visuales
    await loadCollaborators();
  }
};

// Enviar reset de contraseña a colaborador
window.sendPasswordReset = async function(email) {
  if (!confirm(`¿Enviar email de restablecimiento de contraseña a ${email}?\n\nEsto es útil para usuarios que se registraron con Google y necesitan establecer una contraseña para iniciar sesión.`)) {
    return;
  }

  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      throw new Error("No hay sesión activa");
    }

    // Enviar email de reset de contraseña
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/admin/reset-password.html`,
    });

    if (error) {
      throw error;
    }

    showMessage(`Email de restablecimiento de contraseña enviado a ${email}`, "success");

  } catch (error) {
    console.error("Error enviando reset de contraseña:", error);
    showMessage(`Error: ${error.message}`, "error");
  }
};

// Eliminar colaborador
window.deleteCollaborator = async function(adminId, email) {
  if (!confirm(`¿Estás seguro de que deseas eliminar al colaborador ${email}?`)) {
    return;
  }

  try {
    const { error } = await supabase
      .from("admins")
      .delete()
      .eq("id", adminId);

    if (error) throw error;

    showMessage(`Colaborador ${email} eliminado exitosamente`, "success");
    await loadCollaborators();

  } catch (error) {
    console.error("Error eliminando colaborador:", error);
    showMessage(`Error: ${error.message}`, "error");
  }
};

// Mostrar mensaje
function showMessage(message, type = "info") {
  const container = document.getElementById("message-container");
  if (!container) return;

  const messageEl = document.createElement("div");
  messageEl.className = `message ${type}`;
  messageEl.textContent = message;
  container.innerHTML = "";
  container.appendChild(messageEl);

  // Auto-ocultar después de 5 segundos
  setTimeout(() => {
    messageEl.remove();
  }, 5000);
}

// Escapar HTML para prevenir XSS
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

