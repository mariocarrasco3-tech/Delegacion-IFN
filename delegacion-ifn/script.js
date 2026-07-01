/* ==========================================================================
   Portal Delegación IFN 2026 — Comisión de Fiestas Patrias
   Acceso por código (igual que Portal IFN / Aula Virtual) + Firestore
   ========================================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc,
  getDoc, getDocs, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { firebaseConfig, CODIGO_EDICION, CODIGO_LECTURA } from "./config.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const COLECCION_ESTUDIANTES = "estudiantes";
const CLAVE_SESION = "delegacion_rol";

const ETIQUETAS_CAMPO = {
  grado: "Grado que cursa",
  edad: "Edad actual",
  seccion: "Sección de la delegación",
  jornada: "Jornada escolar",
  anios_banda: "Años perteneciendo a la banda",
  seguro_educativo: "Seguro educativo",
  acudiente: "Nombre completo del acudiente",
  telefono_acudiente: "Teléfono del acudiente",
  contacto_emergencia: "Contacto de emergencia",
  alergias: "Alergias / condición médica",
  tipo_sangre: "Tipo de sangre"
};

const ORDEN_CAMPOS = ["grado","edad","seccion","jornada","anios_banda","seguro_educativo",
  "acudiente","telefono_acudiente","contacto_emergencia","alergias","tipo_sangre"];

let ESTUDIANTES = [];          // caché local, alimentada por onSnapshot en tiempo real
let ROL_ACTUAL = null;         // "lectura" | "edicion"
let CATEGORIA_ACTIVA = "Todas";
let TERMINO_BUSQUEDA = "";
let DESUSCRIBIR_SNAPSHOT = null;

/* ---------------------------- Utilidades ---------------------------- */

function normalizarTexto(s) {
  return (s || "").toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function categorizarSeccion(raw) {
  const n = normalizarTexto(raw);
  if (n.includes("guaripola")) return "Guaripola";
  if (n.includes("batutera")) return "Batuteras";
  if (n.includes("femenino")) return "Batallón Femenino";
  if (n.includes("masculino")) return "Batallón Masculino";
  if (n.includes("fusil")) return "Fusiles";
  if (n.includes("folk") || n.includes("folc") || n.includes("tipic") || n.includes("tipoc")) return "Conjunto Folclórico";
  if (n.includes("banda") || n.includes("trompeta") || n.includes("saxof") || n.includes("trombon") || n.includes("percus") || n.includes("flauta") || n.includes("caja")) return "Banda de Música";
  return "Otro";
}

function escaparHTML(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function escaparAtributo(str) {
  return (str ?? "").toString().replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function mostrarAviso(texto, esError = false) {
  const el = document.getElementById("aviso-estado");
  el.textContent = texto;
  el.classList.remove("oculto");
  el.classList.toggle("error", esError);
  if (!esError) setTimeout(() => el.classList.add("oculto"), 3500);
}

/* ---------------------------- Autenticación ---------------------------- */

const pantallaAcceso = document.getElementById("pantalla-acceso");
const appEl = document.getElementById("app");
const formularioAcceso = document.getElementById("formulario-acceso");
const entradaClave = document.getElementById("entrada-clave");
const mensajeError = document.getElementById("mensaje-error");
const botonIngresar = document.getElementById("boton-ingresar");
const insigniaRol = document.getElementById("insignia-rol");
const botonSalir = document.getElementById("boton-salir");
const franjaHerramientas = document.getElementById("franja-herramientas");

formularioAcceso.addEventListener("submit", (e) => {
  e.preventDefault();
  const clave = entradaClave.value.trim();
  if (!clave) return;

  mensajeError.textContent = "";

  let rol = null;
  if (clave === CODIGO_EDICION) rol = "edicion";
  else if (clave === CODIGO_LECTURA) rol = "lectura";

  if (!rol) {
    mensajeError.textContent = "Código incorrecto. Verifique e intente de nuevo.";
    entradaClave.value = "";
    entradaClave.focus();
    return;
  }

  sessionStorage.setItem(CLAVE_SESION, rol);
  entrarConRol(rol);
});

botonSalir.addEventListener("click", () => {
  sessionStorage.removeItem(CLAVE_SESION);
  if (DESUSCRIBIR_SNAPSHOT) { DESUSCRIBIR_SNAPSHOT(); DESUSCRIBIR_SNAPSHOT = null; }
  ROL_ACTUAL = null;
  appEl.classList.add("oculto");
  pantallaAcceso.classList.remove("oculto");
  entradaClave.value = "";
});

function entrarConRol(rol) {
  ROL_ACTUAL = rol;
  pantallaAcceso.classList.add("oculto");
  appEl.classList.remove("oculto");

  if (ROL_ACTUAL === "edicion") {
    insigniaRol.textContent = "Modo edición";
    insigniaRol.classList.remove("lectura");
    insigniaRol.classList.add("edicion");
    franjaHerramientas.classList.remove("oculto");
  } else {
    insigniaRol.textContent = "Solo lectura";
    insigniaRol.classList.remove("edicion");
    insigniaRol.classList.add("lectura");
    franjaHerramientas.classList.add("oculto");
  }

  suscribirEstudiantes();
}

// Si ya había una sesión iniciada en este navegador (misma pestaña), entra directo
const rolGuardado = sessionStorage.getItem(CLAVE_SESION);
if (rolGuardado === "edicion" || rolGuardado === "lectura") {
  entrarConRol(rolGuardado);
}

/* ---------------------------- Sincronización en tiempo real ---------------------------- */

function suscribirEstudiantes() {
  if (DESUSCRIBIR_SNAPSHOT) DESUSCRIBIR_SNAPSHOT();

  DESUSCRIBIR_SNAPSHOT = onSnapshot(
    collection(db, COLECCION_ESTUDIANTES),
    (snapshot) => {
      ESTUDIANTES = snapshot.docs.map(d => ({ _docId: d.id, ...d.data() }));
      construirChips();
      renderizarCuadricula();

      // Si el modal de detalle está abierto, refresca su contenido con
      // los datos más recientes (por si otro editor guardó un cambio).
      if (ID_ABIERTO && MODO_MODAL === "detalle") {
        const actual = ESTUDIANTES.find(e => e._docId === ID_ABIERTO);
        if (actual) abrirModalDetalle(actual._docId, true);
      }
    },
    (error) => {
      console.error(error);
      mostrarAviso("No se pudo conectar con la base de datos. Revisa tu configuración de Firebase.", true);
    }
  );
}

/* ---------------------------- Chips de categoría ---------------------------- */

function construirChips() {
  const contenedor = document.getElementById("fila-chips");
  const categorias = ["Todas", ...new Set(ESTUDIANTES.map(e => e.seccion_categoria || "Otro"))].sort((a,b) => {
    if (a === "Todas") return -1;
    if (b === "Todas") return 1;
    return a.localeCompare(b);
  });

  contenedor.innerHTML = "";
  categorias.forEach(cat => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip" + (cat === CATEGORIA_ACTIVA ? " activo" : "");
    btn.textContent = cat;
    btn.addEventListener("click", () => {
      CATEGORIA_ACTIVA = cat;
      construirChips();
      renderizarCuadricula();
    });
    contenedor.appendChild(btn);
  });
}

/* ---------------------------- Búsqueda ---------------------------- */

const entradaBuscador = document.getElementById("entrada-buscador");
entradaBuscador.addEventListener("input", (e) => {
  TERMINO_BUSQUEDA = e.target.value;
  renderizarCuadricula();
});

function filtrarEstudiantes() {
  const termino = normalizarTexto(TERMINO_BUSQUEDA);
  return ESTUDIANTES.filter(est => {
    const coincideCategoria = CATEGORIA_ACTIVA === "Todas" || est.seccion_categoria === CATEGORIA_ACTIVA;
    if (!coincideCategoria) return false;
    if (!termino) return true;
    const campoBusqueda = normalizarTexto(`${est.nombre} ${est.grado} ${est.seccion}`);
    return campoBusqueda.includes(termino);
  });
}

/* ---------------------------- Cuadrícula ---------------------------- */

const cuadricula = document.getElementById("cuadricula");
const contadorResultados = document.getElementById("contador-resultados");

function renderizarCuadricula() {
  const resultados = filtrarEstudiantes();
  contadorResultados.textContent = `${resultados.length} de ${ESTUDIANTES.length} integrantes`;
  cuadricula.innerHTML = "";

  if (ESTUDIANTES.length === 0) {
    cuadricula.innerHTML = `
      <div class="sin-resultados">
        <strong>Aún no hay estudiantes cargados</strong>
        ${ROL_ACTUAL === "edicion"
          ? 'Usa "⇪ Importar datos iniciales" para cargar los 164 del Excel, o "＋ Agregar estudiante" para empezar de cero.'
          : "Pide a alguien con acceso de edición que cargue los datos."}
      </div>`;
    return;
  }

  if (resultados.length === 0) {
    cuadricula.innerHTML = `
      <div class="sin-resultados">
        <strong>Sin resultados</strong>
        No encontramos ningún integrante con ese criterio de búsqueda.
      </div>`;
    return;
  }

  resultados
    .sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "", "es"))
    .forEach(est => {
      const tarjeta = document.createElement("button");
      tarjeta.type = "button";
      tarjeta.className = "tarjeta-estudiante";
      const numero = est.id ? `#${String(est.id).padStart(3,"0")}` : "#—";
      tarjeta.innerHTML = `
        <div class="tarjeta-numero">${numero}</div>
        <div class="tarjeta-nombre">${escaparHTML(est.nombre)}</div>
        <div class="tarjeta-meta">
          <span class="etiqueta categoria">${escaparHTML(est.seccion_categoria || "Otro")}</span>
          <span class="etiqueta">${escaparHTML(est.grado || "—")}</span>
        </div>
        <div class="tarjeta-detalle-rapido">${escaparHTML(est.edad || "—")} años · ${escaparHTML(est.jornada || "—")}</div>
      `;
      tarjeta.addEventListener("click", () => abrirModalDetalle(est._docId));
      cuadricula.appendChild(tarjeta);
    });
}

/* ---------------------------- Modal: detalle / edición / nuevo ---------------------------- */

const fondoModal = document.getElementById("fondo-modal");
const modalNombre = document.getElementById("modal-nombre");
const modalMeta = document.getElementById("modal-meta");
const modalCuerpo = document.getElementById("modal-cuerpo");
const botonCerrarModal = document.getElementById("boton-cerrar-modal");

let ID_ABIERTO = null;
let MODO_MODAL = null; // "detalle" | "nuevo"

function esCampoAlerta(campo, valor) {
  if (campo !== "alergias") return false;
  const v = normalizarTexto(valor);
  return v !== "" && v !== "no" && v !== "n/a" && v !== "ninguna" && v !== "ninguno";
}

function abrirModalDetalle(docId, esRefresco = false) {
  MODO_MODAL = "detalle";
  ID_ABIERTO = docId;
  const est = ESTUDIANTES.find(e => e._docId === docId);
  if (!est) return;

  modalNombre.textContent = est.nombre || "(sin nombre)";
  modalMeta.innerHTML = `
    <span class="etiqueta">${est.id ? "#" + String(est.id).padStart(3,"0") : "—"}</span>
    <span class="etiqueta">${escaparHTML(est.seccion_categoria || "Otro")}</span>
    <span class="etiqueta">${escaparHTML(est.edad || "—")} años</span>
  `;

  if (ROL_ACTUAL === "edicion") {
    renderizarCuerpoEditable(est);
  } else {
    renderizarCuerpoSoloLectura(est);
  }

  if (!esRefresco) {
    fondoModal.classList.remove("oculto");
    document.body.style.overflow = "hidden";
  }
}

function cerrarModal() {
  fondoModal.classList.add("oculto");
  document.body.style.overflow = "";
  ID_ABIERTO = null;
  MODO_MODAL = null;
}

botonCerrarModal.addEventListener("click", cerrarModal);
fondoModal.addEventListener("click", (e) => { if (e.target === fondoModal) cerrarModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !fondoModal.classList.contains("oculto")) cerrarModal(); });

function renderizarCuerpoSoloLectura(est) {
  let html = "";
  ORDEN_CAMPOS.forEach(campo => {
    const valor = est[campo] || "—";
    const claseAlerta = esCampoAlerta(campo, est[campo]) ? " alerta" : "";
    html += `
      <div class="grupo-campo">
        <div class="etiqueta-campo">${ETIQUETAS_CAMPO[campo]}</div>
        <div class="valor-campo${claseAlerta}">${escaparHTML(valor)}</div>
      </div>`;
  });
  modalCuerpo.innerHTML = html;
}

function renderizarCuerpoEditable(est) {
  let html = `<div id="campos-editables">`;
  ORDEN_CAMPOS.forEach(campo => {
    html += `
      <div class="grupo-campo">
        <div class="etiqueta-campo">${ETIQUETAS_CAMPO[campo]}</div>
        <input type="text" class="entrada-editable" data-campo="${campo}" value="${escaparAtributo(est[campo] || "")}">
      </div>`;
  });
  html += `</div>
    <div class="franja-editor">
      <button type="button" id="boton-eliminar" class="boton-peligro">🗑 Eliminar estudiante</button>
      <button type="button" id="boton-guardar-cambios" class="boton-guardar">Guardar cambios</button>
    </div>
    <p id="confirmacion-guardado" class="confirmacion-guardado"></p>
  `;
  modalCuerpo.innerHTML = html;

  document.getElementById("boton-guardar-cambios").addEventListener("click", () => guardarCambiosEstudiante(est._docId));
  document.getElementById("boton-eliminar").addEventListener("click", () => eliminarEstudiante(est._docId, est.nombre));
}

async function guardarCambiosEstudiante(docId) {
  const contenedor = document.getElementById("campos-editables");
  const entradas = contenedor.querySelectorAll(".entrada-editable");
  const cambios = {};
  entradas.forEach(inp => { cambios[inp.dataset.campo] = inp.value.trim(); });
  cambios.seccion_categoria = categorizarSeccion(cambios.seccion);

  const confirmacion = document.getElementById("confirmacion-guardado");
  try {
    await updateDoc(doc(db, COLECCION_ESTUDIANTES, docId), cambios);
    confirmacion.textContent = "✓ Cambios guardados — visibles para toda la comisión.";
  } catch (err) {
    console.error(err);
    confirmacion.textContent = "✕ No se pudo guardar. Revisa tu conexión o permisos.";
  }
}

async function eliminarEstudiante(docId, nombre) {
  const confirmar = confirm(`¿Eliminar a "${nombre}" de la delegación? Esta acción no se puede deshacer.`);
  if (!confirmar) return;
  try {
    await deleteDoc(doc(db, COLECCION_ESTUDIANTES, docId));
    cerrarModal();
    mostrarAviso(`"${nombre}" fue eliminado.`);
  } catch (err) {
    console.error(err);
    mostrarAviso("No se pudo eliminar. Revisa tu conexión o permisos.", true);
  }
}

/* ---------------------------- Agregar estudiante ---------------------------- */

document.getElementById("boton-agregar").addEventListener("click", abrirModalNuevo);

function abrirModalNuevo() {
  MODO_MODAL = "nuevo";
  ID_ABIERTO = null;

  modalNombre.textContent = "Agregar estudiante";
  modalMeta.innerHTML = `<span class="etiqueta">Nuevo integrante</span>`;

  let html = `<div id="campos-nuevo">
    <div class="grupo-campo">
      <div class="etiqueta-campo">Nombre completo del estudiante</div>
      <input type="text" class="entrada-editable" data-campo="nombre" placeholder="Ej. María López González">
    </div>`;
  ORDEN_CAMPOS.forEach(campo => {
    html += `
      <div class="grupo-campo">
        <div class="etiqueta-campo">${ETIQUETAS_CAMPO[campo]}</div>
        <input type="text" class="entrada-editable" data-campo="${campo}" placeholder="">
      </div>`;
  });
  html += `</div>
    <div class="franja-editor">
      <button type="button" id="boton-cancelar-nuevo" class="boton-secundario">Cancelar</button>
      <button type="button" id="boton-crear" class="boton-guardar">Crear estudiante</button>
    </div>
    <p id="confirmacion-guardado" class="confirmacion-guardado"></p>
  `;
  modalCuerpo.innerHTML = html;

  document.getElementById("boton-cancelar-nuevo").addEventListener("click", cerrarModal);
  document.getElementById("boton-crear").addEventListener("click", crearEstudiante);

  fondoModal.classList.remove("oculto");
  document.body.style.overflow = "hidden";
}

async function crearEstudiante() {
  const contenedor = document.getElementById("campos-nuevo");
  const entradas = contenedor.querySelectorAll(".entrada-editable");
  const nuevo = {};
  entradas.forEach(inp => { nuevo[inp.dataset.campo] = inp.value.trim(); });

  const confirmacion = document.getElementById("confirmacion-guardado");

  if (!nuevo.nombre) {
    confirmacion.textContent = "✕ El nombre del estudiante es obligatorio.";
    return;
  }

  nuevo.seccion_categoria = categorizarSeccion(nuevo.seccion || "");
  const siguienteId = ESTUDIANTES.reduce((max, e) => Math.max(max, Number(e.id) || 0), 0) + 1;
  nuevo.id = siguienteId;

  try {
    const nuevoDoc = doc(collection(db, COLECCION_ESTUDIANTES));
    await setDoc(nuevoDoc, nuevo);
    cerrarModal();
    mostrarAviso(`"${nuevo.nombre}" fue agregado a la delegación.`);
  } catch (err) {
    console.error(err);
    confirmacion.textContent = "✕ No se pudo crear. Revisa tu conexión o permisos.";
  }
}

/* ---------------------------- Herramientas globales ---------------------------- */

document.getElementById("boton-exportar").addEventListener("click", () => {
  const datos = ESTUDIANTES.map(({ _docId, ...resto }) => resto);
  const blob = new Blob([JSON.stringify(datos, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const fecha = new Date().toISOString().slice(0,10);
  a.href = url;
  a.download = `delegacion-ifn-2026-respaldo-${fecha}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

document.getElementById("boton-importar-inicial").addEventListener("click", async () => {
  const confirmar = confirm(
    "Esto carga los 164 estudiantes del Excel original a la base de datos. " +
    "Es seguro ejecutarlo varias veces (no duplica), pero SOBRESCRIBE cualquier " +
    "cambio que se haya hecho a esos 164 registros específicos. ¿Continuar?"
  );
  if (!confirmar) return;

  try {
    const resp = await fetch("data-inicial.json");
    const datosIniciales = await resp.json();

    const lote = writeBatch(db);
    datosIniciales.forEach(est => {
      const refDoc = doc(db, COLECCION_ESTUDIANTES, String(est.id));
      lote.set(refDoc, est);
    });
    await lote.commit();
    mostrarAviso(`Se importaron ${datosIniciales.length} estudiantes iniciales.`);
  } catch (err) {
    console.error(err);
    mostrarAviso("No se pudo importar. Revisa tu conexión o permisos.", true);
  }
});
