/* ==========================================================================
   Portal Delegación IFN 2026 — Comisión de Fiestas Patrias
   Acceso por código (igual que Portal IFN / Aula Virtual) + Firestore
   ========================================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc,
  getDoc, getDocs, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import {
  getAuth, setPersistence, browserSessionPersistence,
  signInWithEmailAndPassword, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

import { firebaseConfig, CORREO_EDITOR, CORREO_LECTOR } from "./config.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
// La sesión dura mientras la pestaña esté abierta (igual que antes).
setPersistence(auth, browserSessionPersistence).catch(() => {});

const COLECCION_ESTUDIANTES = "estudiantes";
const COLECCION_INVENTARIO = "inventario";

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
let VISTA = "inicio";          // "inicio" | "categoria" | "inventario"
let CATEGORIA_ACTIVA = "Todas";
let TERMINO_BUSQUEDA = "";
let FILTRO_CAMPO = "";
let FILTRO_VALOR = "";
let DESUSCRIBIR_SNAPSHOT = null;
let DESUSCRIBIR_INVENTARIO = null;

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

formularioAcceso.addEventListener("submit", async (e) => {
  e.preventDefault();
  const clave = entradaClave.value.trim();
  if (!clave) return;

  mensajeError.textContent = "";
  botonIngresar.disabled = true;

  // El código escrito es la contraseña de la cuenta de edición o la de lectura.
  let ok = false;
  try {
    await signInWithEmailAndPassword(auth, CORREO_EDITOR, clave);
    ok = true;
  } catch (_) {
    try {
      await signInWithEmailAndPassword(auth, CORREO_LECTOR, clave);
      ok = true;
    } catch (err) {
      console.error(err);
      mensajeError.textContent = (err && err.code === "auth/too-many-requests")
        ? "Demasiados intentos. Espere unos minutos e intente de nuevo."
        : "Código incorrecto. Verifique e intente de nuevo.";
    }
  }

  botonIngresar.disabled = false;
  if (!ok) {
    entradaClave.value = "";
    entradaClave.focus();
  }
  // Si ok, onAuthStateChanged se encarga de abrir el portal.
});

botonSalir.addEventListener("click", () => { signOut(auth); });

function salirDelPortal() {
  if (DESUSCRIBIR_SNAPSHOT) { DESUSCRIBIR_SNAPSHOT(); DESUSCRIBIR_SNAPSHOT = null; }
  if (DESUSCRIBIR_INVENTARIO) { DESUSCRIBIR_INVENTARIO(); DESUSCRIBIR_INVENTARIO = null; }
  ROL_ACTUAL = null;
  ESTUDIANTES = [];
  INVENTARIO = [];
  cerrarModal();
  appEl.classList.add("oculto");
  pantallaAcceso.classList.remove("oculto");
  entradaClave.value = "";
}

function entrarConRol(rol) {
  ROL_ACTUAL = rol;
  pantallaAcceso.classList.add("oculto");
  appEl.classList.remove("oculto");

  if (ROL_ACTUAL === "edicion") {
    insigniaRol.textContent = "Modo edición";
    insigniaRol.classList.remove("lectura");
    insigniaRol.classList.add("edicion");
  } else {
    insigniaRol.textContent = "Solo lectura";
    insigniaRol.classList.remove("edicion");
    insigniaRol.classList.add("lectura");
  }

  document.getElementById("boton-agregar-item")
    .classList.toggle("oculto", ROL_ACTUAL !== "edicion");

  mostrarVista("inicio");
  suscribirEstudiantes();
  suscribirInventario();
}

// Firebase avisa cuando hay (o deja de haber) una sesión iniciada.
onAuthStateChanged(auth, (user) => {
  if (user) {
    entrarConRol(user.email === CORREO_EDITOR ? "edicion" : "lectura");
  } else {
    salirDelPortal();
  }
});

/* ---------------------------- Sincronización en tiempo real ---------------------------- */

function suscribirEstudiantes() {
  if (DESUSCRIBIR_SNAPSHOT) DESUSCRIBIR_SNAPSHOT();

  DESUSCRIBIR_SNAPSHOT = onSnapshot(
    collection(db, COLECCION_ESTUDIANTES),
    (snapshot) => {
      ESTUDIANTES = snapshot.docs.map(d => ({ _docId: d.id, ...d.data() }));
      construirCategorias();
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

function suscribirInventario() {
  if (DESUSCRIBIR_INVENTARIO) DESUSCRIBIR_INVENTARIO();

  DESUSCRIBIR_INVENTARIO = onSnapshot(
    collection(db, COLECCION_INVENTARIO),
    (snapshot) => {
      INVENTARIO = snapshot.docs.map(d => ({ _docId: d.id, ...d.data() }));
      construirCategorias();       // actualiza el contador de la tarjeta Inventario
      construirChipsInventario();
      renderizarInventario();
    },
    (error) => {
      console.error(error);
      mostrarAviso("No se pudo cargar el inventario. Revisa las reglas de Firestore.", true);
    }
  );
}

/* ---------------------------- Vistas (inicio / sección / inventario) ---------------------------- */

const vistaInicio = document.getElementById("vista-inicio");
const vistaLista = document.getElementById("vista-lista");
const vistaInventario = document.getElementById("vista-inventario");

function mostrarVista(nombre) {
  VISTA = nombre;
  vistaInicio.classList.toggle("oculto", nombre !== "inicio");
  vistaLista.classList.toggle("oculto", nombre !== "categoria");
  vistaInventario.classList.toggle("oculto", nombre !== "inventario");
  // Las herramientas (agregar / importar / respaldo) son de estudiantes:
  // solo se ven en modo edición y fuera del inventario.
  franjaHerramientas.classList.toggle("oculto", ROL_ACTUAL !== "edicion" || nombre === "inventario");
  window.scrollTo(0, 0);
}

document.querySelectorAll("[data-volver]").forEach(btn => {
  btn.addEventListener("click", () => mostrarVista("inicio"));
});

function abrirCategoria(cat) {
  CATEGORIA_ACTIVA = cat;
  TERMINO_BUSQUEDA = "";
  FILTRO_CAMPO = "";
  FILTRO_VALOR = "";
  entradaBuscador.value = "";
  selectorCampoFiltro.value = "";
  selectorValorFiltro.innerHTML = "";
  selectorValorFiltro.classList.add("oculto");
  conteoFiltroAvanzado.classList.add("oculto");
  document.getElementById("titulo-lista").textContent =
    cat === "Todas" ? "Todos los integrantes" : cat;
  renderizarCuadricula();
  mostrarVista("categoria");
}

function abrirInventario() {
  TERMINO_INV = "";
  TIPO_INV_ACTIVO = "Todos";
  document.getElementById("entrada-buscador-inv").value = "";
  construirChipsInventario();
  renderizarInventario();
  mostrarVista("inventario");
}

/* ---------------------------- Tarjetas de categoría (pantalla de inicio) ---------------------------- */

const ORDEN_CATEGORIAS = [
  "Banda de Música", "Conjunto Folclórico", "Guaripola", "Batuteras",
  "Batallón Femenino", "Batallón Masculino", "Fusiles", "Otro"
];

const ICONOS_CATEGORIA = {
  "Banda de Música": "🎺", "Conjunto Folclórico": "💃", "Guaripola": "⭐",
  "Batuteras": "🎀", "Batallón Femenino": "🚩", "Batallón Masculino": "🚩",
  "Fusiles": "🎖️", "Otro": "👥", "Todas": "👥"
};

function construirCategorias() {
  const contenedor = document.getElementById("cuadricula-categorias");
  if (!contenedor) return;

  const conteos = {};
  ESTUDIANTES.forEach(e => {
    const c = e.seccion_categoria || "Otro";
    conteos[c] = (conteos[c] || 0) + 1;
  });

  const presentes = Object.keys(conteos);
  const ordenadas = [
    ...ORDEN_CATEGORIAS.filter(c => conteos[c]),
    ...presentes.filter(c => !ORDEN_CATEGORIAS.includes(c)).sort((a, b) => a.localeCompare(b, "es"))
  ];

  contenedor.innerHTML = "";

  const crearTarjeta = ({ icono, titulo, subtitulo, clase, alClick }) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tarjeta-categoria" + (clase ? " " + clase : "");
    btn.innerHTML = `
      <span class="icono-categoria">${icono}</span>
      <span class="nombre-categoria">${escaparHTML(titulo)}</span>
      <span class="conteo-categoria">${escaparHTML(subtitulo)}</span>`;
    btn.addEventListener("click", alClick);
    contenedor.appendChild(btn);
  };

  if (ESTUDIANTES.length > 0) {
    ordenadas.forEach(cat => crearTarjeta({
      icono: ICONOS_CATEGORIA[cat] || "👥",
      titulo: cat,
      subtitulo: `${conteos[cat]} integrante${conteos[cat] === 1 ? "" : "s"}`,
      alClick: () => abrirCategoria(cat)
    }));

    crearTarjeta({
      icono: ICONOS_CATEGORIA["Todas"],
      titulo: "Todos los integrantes",
      subtitulo: `${ESTUDIANTES.length} en total`,
      clase: "todas",
      alClick: () => abrirCategoria("Todas")
    });
  }

  crearTarjeta({
    icono: "📦",
    titulo: "Inventario",
    subtitulo: `${INVENTARIO.length} artículo${INVENTARIO.length === 1 ? "" : "s"}`,
    clase: "inventario",
    alClick: abrirInventario
  });

  if (ESTUDIANTES.length === 0) {
    const aviso = document.createElement("div");
    aviso.className = "sin-resultados aviso-vacio";
    aviso.innerHTML = `
      <strong>Aún no hay estudiantes cargados</strong>
      ${ROL_ACTUAL === "edicion"
        ? 'Usa "⇪ Importar datos iniciales" para cargar los 164 del Excel, o "＋ Agregar estudiante" para empezar de cero.'
        : "Pide a alguien con acceso de edición que cargue los datos."}`;
    contenedor.prepend(aviso);
  }
}

/* ---------------------------- Búsqueda ---------------------------- */

const entradaBuscador = document.getElementById("entrada-buscador");
entradaBuscador.addEventListener("input", (e) => {
  TERMINO_BUSQUEDA = e.target.value;
  renderizarCuadricula();
});

/* ---------------------------- Filtro avanzado (por cualquier pregunta) ---------------------------- */

const ETIQUETAS_FILTRO = {
  grado: "Grado",
  jornada: "Jornada",
  seguro_educativo: "Seguro educativo",
  tipo_sangre: "Tipo de sangre",
  anios_banda: "Años en la banda"
};

const selectorCampoFiltro = document.getElementById("selector-campo-filtro");
const selectorValorFiltro = document.getElementById("selector-valor-filtro");
const conteoFiltroAvanzado = document.getElementById("conteo-filtro-avanzado");

selectorCampoFiltro.addEventListener("change", () => {
  FILTRO_CAMPO = selectorCampoFiltro.value;
  FILTRO_VALOR = "";
  conteoFiltroAvanzado.classList.add("oculto");

  if (!FILTRO_CAMPO) {
    selectorValorFiltro.classList.add("oculto");
    selectorValorFiltro.innerHTML = "";
    renderizarCuadricula();
    return;
  }

  const valores = [...new Set(estudiantesDeCategoria().map(e => (e[FILTRO_CAMPO] || "").trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "es"));

  selectorValorFiltro.innerHTML = `<option value="">Elige un valor…</option>` +
    valores.map(v => `<option value="${escaparAtributo(v)}">${escaparHTML(v)}</option>`).join("");
  selectorValorFiltro.classList.remove("oculto");
  renderizarCuadricula();
});

selectorValorFiltro.addEventListener("change", () => {
  FILTRO_VALOR = selectorValorFiltro.value;
  renderizarCuadricula();
});

function estudiantesDeCategoria() {
  return ESTUDIANTES.filter(est => CATEGORIA_ACTIVA === "Todas" || (est.seccion_categoria || "Otro") === CATEGORIA_ACTIVA);
}

function filtrarEstudiantes() {
  const termino = normalizarTexto(TERMINO_BUSQUEDA);
  return ESTUDIANTES.filter(est => {
    const coincideCategoria = CATEGORIA_ACTIVA === "Todas" || (est.seccion_categoria || "Otro") === CATEGORIA_ACTIVA;
    if (!coincideCategoria) return false;
    if (FILTRO_CAMPO && FILTRO_VALOR && (est[FILTRO_CAMPO] || "").trim() !== FILTRO_VALOR) return false;
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
  contadorResultados.textContent = `${resultados.length} de ${estudiantesDeCategoria().length} integrantes`;
  cuadricula.innerHTML = "";

  if (FILTRO_CAMPO && FILTRO_VALOR) {
    conteoFiltroAvanzado.textContent = `${resultados.length} estudiante${resultados.length === 1 ? "" : "s"} con ${ETIQUETAS_FILTRO[FILTRO_CAMPO] || FILTRO_CAMPO}: "${FILTRO_VALOR}"`;
    conteoFiltroAvanzado.classList.remove("oculto");
  } else {
    conteoFiltroAvanzado.classList.add("oculto");
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
      tarjeta.innerHTML = `
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
  let html = `<div id="campos-editables">
    <div class="grupo-campo">
      <div class="etiqueta-campo">Nombre completo del estudiante</div>
      <input type="text" class="entrada-editable" data-campo="nombre" value="${escaparAtributo(est.nombre || "")}">
    </div>`;
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

/* ==========================================================================
   INVENTARIO — instrumentos, uniformes, accesorios… con foto
   Las fotos se reducen en el navegador (≈800 px, JPEG) y se guardan dentro
   del propio documento de Firestore, así no hace falta Firebase Storage.
   ========================================================================== */

let INVENTARIO = [];
let TIPO_INV_ACTIVO = "Todos";
let TERMINO_INV = "";

const ESTADOS_INV = ["Bueno", "Regular", "Dañado", "En reparación"];
const TIPOS_INV_SUGERIDOS = ["Instrumento de viento", "Percusión", "Uniforme", "Accesorio", "Otro"];
const MAX_CARACTERES_FOTO = 700000; // límite de Firestore: 1 MB por documento

const ETIQUETAS_INV = {
  nombre: "Nombre del artículo",
  tipo: "Tipo",
  cantidad: "Cantidad",
  estado: "Estado",
  ubicacion: "Ubicación / responsable",
  notas: "Notas"
};

function claseEstado(estado) {
  const n = normalizarTexto(estado);
  if (n === "bueno") return "estado-bueno";
  if (n === "regular") return "estado-regular";
  if (n === "danado" || n.includes("reparacion")) return "estado-malo";
  return "";
}

/* ---------------------------- Búsqueda y chips ---------------------------- */

document.getElementById("entrada-buscador-inv").addEventListener("input", (e) => {
  TERMINO_INV = e.target.value;
  renderizarInventario();
});

function construirChipsInventario() {
  const contenedor = document.getElementById("fila-chips-inv");
  const tipos = ["Todos", ...[...new Set(INVENTARIO.map(i => i.tipo || "Otro"))].sort((a, b) => a.localeCompare(b, "es"))];
  contenedor.innerHTML = "";
  tipos.forEach(tipo => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip" + (tipo === TIPO_INV_ACTIVO ? " activo" : "");
    btn.textContent = tipo;
    btn.addEventListener("click", () => {
      TIPO_INV_ACTIVO = tipo;
      construirChipsInventario();
      renderizarInventario();
    });
    contenedor.appendChild(btn);
  });
}

/* ---------------------------- Cuadrícula ---------------------------- */

function renderizarInventario() {
  const cont = document.getElementById("cuadricula-inventario");
  const contador = document.getElementById("contador-inventario");
  if (!cont) return;

  const termino = normalizarTexto(TERMINO_INV);
  const resultados = INVENTARIO.filter(it => {
    if (TIPO_INV_ACTIVO !== "Todos" && (it.tipo || "Otro") !== TIPO_INV_ACTIVO) return false;
    if (!termino) return true;
    return normalizarTexto(`${it.nombre} ${it.tipo} ${it.ubicacion} ${it.estado}`).includes(termino);
  });

  contador.textContent = `${resultados.length} de ${INVENTARIO.length} artículos`;
  cont.innerHTML = "";

  if (INVENTARIO.length === 0) {
    cont.innerHTML = `
      <div class="sin-resultados">
        <strong>El inventario está vacío</strong>
        ${ROL_ACTUAL === "edicion"
          ? 'Usa "＋ Agregar artículo" para registrar el primer instrumento, con su foto.'
          : "Pide a alguien con acceso de edición que cargue el inventario."}
      </div>`;
    return;
  }
  if (resultados.length === 0) {
    cont.innerHTML = `
      <div class="sin-resultados">
        <strong>Sin resultados</strong>
        No encontramos ningún artículo con ese criterio.
      </div>`;
    return;
  }

  resultados
    .sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "", "es"))
    .forEach(it => {
      const tarjeta = document.createElement("button");
      tarjeta.type = "button";
      tarjeta.className = "tarjeta-inventario";
      const foto = it.foto
        ? `<img src="${escaparAtributo(it.foto)}" alt="${escaparAtributo(it.nombre)}" loading="lazy">`
        : `<span class="sin-foto">📦</span>`;
      tarjeta.innerHTML = `
        <div class="foto-inventario">${foto}</div>
        <div class="cuerpo-inventario">
          <div class="tarjeta-nombre">${escaparHTML(it.nombre || "(sin nombre)")}</div>
          <div class="tarjeta-meta">
            <span class="etiqueta categoria">${escaparHTML(it.tipo || "Otro")}</span>
            ${it.estado ? `<span class="etiqueta ${claseEstado(it.estado)}">${escaparHTML(it.estado)}</span>` : ""}
          </div>
          <div class="tarjeta-detalle-rapido">Cantidad: ${escaparHTML(it.cantidad ?? "—")}</div>
        </div>`;
      tarjeta.addEventListener("click", () => abrirModalInventario(it._docId));
      cont.appendChild(tarjeta);
    });
}

/* ---------------------------- Foto: reducir y convertir ---------------------------- */

function reducirImagen(archivo, maxLado = 800) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(archivo);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const escala = Math.min(1, maxLado / Math.max(img.width, img.height));
      const lienzo = document.createElement("canvas");
      lienzo.width = Math.round(img.width * escala);
      lienzo.height = Math.round(img.height * escala);
      lienzo.getContext("2d").drawImage(img, 0, 0, lienzo.width, lienzo.height);

      let calidad = 0.75;
      let data = lienzo.toDataURL("image/jpeg", calidad);
      while (data.length > MAX_CARACTERES_FOTO && calidad > 0.3) {
        calidad -= 0.1;
        data = lienzo.toDataURL("image/jpeg", calidad);
      }
      data.length > MAX_CARACTERES_FOTO ? reject(new Error("Foto demasiado grande")) : resolve(data);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("No se pudo leer la imagen")); };
    img.src = url;
  });
}

/* ---------------------------- Modal: detalle / formulario ---------------------------- */

function abrirModalInventario(docId) {
  const it = INVENTARIO.find(i => i._docId === docId);
  if (!it) return;
  ID_ABIERTO = docId;

  modalNombre.textContent = it.nombre || "(sin nombre)";
  modalMeta.innerHTML = `
    <span class="etiqueta">${escaparHTML(it.tipo || "Otro")}</span>
    ${it.estado ? `<span class="etiqueta">${escaparHTML(it.estado)}</span>` : ""}`;

  if (ROL_ACTUAL === "edicion") {
    MODO_MODAL = "inv-editar";
    renderizarFormularioInventario(it);
  } else {
    MODO_MODAL = "inv-detalle";
    const foto = it.foto
      ? `<div class="grupo-campo"><img class="foto-grande" src="${escaparAtributo(it.foto)}" alt="${escaparAtributo(it.nombre)}"></div>`
      : "";
    let html = foto;
    ["tipo", "cantidad", "estado", "ubicacion", "notas"].forEach(c => {
      html += `
        <div class="grupo-campo">
          <div class="etiqueta-campo">${ETIQUETAS_INV[c]}</div>
          <div class="valor-campo">${escaparHTML(it[c] ?? "") || "—"}</div>
        </div>`;
    });
    modalCuerpo.innerHTML = html;
  }

  fondoModal.classList.remove("oculto");
  document.body.style.overflow = "hidden";
}

document.getElementById("boton-agregar-item").addEventListener("click", () => {
  MODO_MODAL = "inv-nuevo";
  ID_ABIERTO = null;
  modalNombre.textContent = "Agregar artículo";
  modalMeta.innerHTML = `<span class="etiqueta">Nuevo artículo</span>`;
  renderizarFormularioInventario(null);
  fondoModal.classList.remove("oculto");
  document.body.style.overflow = "hidden";
});

function renderizarFormularioInventario(it) {
  const esNuevo = !it;
  const v = (c) => escaparAtributo(it?.[c] ?? "");
  let fotoActual = it?.foto || "";

  const opcionesEstado = ESTADOS_INV
    .map(e => `<option value="${e}" ${it?.estado === e ? "selected" : ""}>${e}</option>`).join("");
  const opcionesTipo = TIPOS_INV_SUGERIDOS
    .concat([...new Set(INVENTARIO.map(i => i.tipo).filter(Boolean))])
    .filter((t, i, arr) => arr.indexOf(t) === i)
    .map(t => `<option value="${escaparAtributo(t)}"></option>`).join("");

  modalCuerpo.innerHTML = `
    <div id="campos-inventario">
      <div class="grupo-campo">
        <div class="etiqueta-campo">Foto</div>
        <div id="vista-previa-foto" class="vista-previa-foto"></div>
        <input type="file" id="entrada-foto" accept="image/*" class="entrada-archivo">
        <button type="button" id="boton-quitar-foto" class="boton-secundario boton-chico">Quitar foto</button>
      </div>
      <div class="grupo-campo">
        <div class="etiqueta-campo">${ETIQUETAS_INV.nombre}</div>
        <input type="text" class="entrada-editable" data-campo="nombre" value="${v("nombre")}" placeholder="Ej. Trompeta Yamaha #3">
      </div>
      <div class="rejilla-dos">
        <div class="grupo-campo">
          <div class="etiqueta-campo">${ETIQUETAS_INV.tipo}</div>
          <input type="text" class="entrada-editable" data-campo="tipo" value="${v("tipo")}" list="lista-tipos-inv" placeholder="Elige o escribe">
          <datalist id="lista-tipos-inv">${opcionesTipo}</datalist>
        </div>
        <div class="grupo-campo">
          <div class="etiqueta-campo">${ETIQUETAS_INV.cantidad}</div>
          <input type="number" min="0" class="entrada-editable" data-campo="cantidad" value="${v("cantidad") || (esNuevo ? 1 : "")}">
        </div>
      </div>
      <div class="rejilla-dos">
        <div class="grupo-campo">
          <div class="etiqueta-campo">${ETIQUETAS_INV.estado}</div>
          <select class="entrada-editable" data-campo="estado">${opcionesEstado}</select>
        </div>
        <div class="grupo-campo">
          <div class="etiqueta-campo">${ETIQUETAS_INV.ubicacion}</div>
          <input type="text" class="entrada-editable" data-campo="ubicacion" value="${v("ubicacion")}" placeholder="Ej. Depósito / Prof. Pérez">
        </div>
      </div>
      <div class="grupo-campo">
        <div class="etiqueta-campo">${ETIQUETAS_INV.notas}</div>
        <textarea class="entrada-editable" data-campo="notas" rows="3">${escaparHTML(it?.notas ?? "")}</textarea>
      </div>
    </div>
    <div class="franja-editor">
      ${esNuevo
        ? `<button type="button" id="boton-cancelar-inv" class="boton-secundario">Cancelar</button>`
        : `<button type="button" id="boton-eliminar-inv" class="boton-peligro">🗑 Eliminar artículo</button>`}
      <button type="button" id="boton-guardar-inv" class="boton-guardar">${esNuevo ? "Crear artículo" : "Guardar cambios"}</button>
    </div>
    <p id="confirmacion-guardado" class="confirmacion-guardado"></p>`;

  const vistaPrevia = document.getElementById("vista-previa-foto");
  const pintarFoto = () => {
    vistaPrevia.innerHTML = fotoActual
      ? `<img src="${escaparAtributo(fotoActual)}" alt="Vista previa">`
      : `<span class="sin-foto">📦 Sin foto</span>`;
    document.getElementById("boton-quitar-foto").classList.toggle("oculto", !fotoActual);
  };
  pintarFoto();

  const confirmacion = document.getElementById("confirmacion-guardado");

  document.getElementById("entrada-foto").addEventListener("change", async (e) => {
    const archivo = e.target.files[0];
    if (!archivo) return;
    confirmacion.textContent = "Procesando foto…";
    try {
      fotoActual = await reducirImagen(archivo);
      confirmacion.textContent = "";
      pintarFoto();
    } catch (err) {
      console.error(err);
      confirmacion.textContent = "✕ No se pudo usar esa foto. Prueba con otra imagen.";
    }
  });

  document.getElementById("boton-quitar-foto").addEventListener("click", () => {
    fotoActual = "";
    document.getElementById("entrada-foto").value = "";
    pintarFoto();
  });

  document.getElementById("boton-guardar-inv").addEventListener("click", async () => {
    const datos = {};
    document.querySelectorAll("#campos-inventario [data-campo]").forEach(inp => {
      datos[inp.dataset.campo] = inp.value.trim();
    });
    if (!datos.nombre) {
      confirmacion.textContent = "✕ El nombre del artículo es obligatorio.";
      return;
    }
    datos.tipo = datos.tipo || "Otro";
    datos.cantidad = datos.cantidad === "" ? 1 : Number(datos.cantidad);
    datos.foto = fotoActual;

    try {
      if (esNuevo) {
        await setDoc(doc(collection(db, COLECCION_INVENTARIO)), datos);
        cerrarModal();
        mostrarAviso(`"${datos.nombre}" fue agregado al inventario.`);
      } else {
        await updateDoc(doc(db, COLECCION_INVENTARIO, it._docId), datos);
        confirmacion.textContent = "✓ Cambios guardados.";
      }
    } catch (err) {
      console.error(err);
      confirmacion.textContent = "✕ No se pudo guardar. Revisa tu conexión o permisos.";
    }
  });

  if (esNuevo) {
    document.getElementById("boton-cancelar-inv").addEventListener("click", cerrarModal);
  } else {
    document.getElementById("boton-eliminar-inv").addEventListener("click", async () => {
      if (!confirm(`¿Eliminar "${it.nombre}" del inventario? Esta acción no se puede deshacer.`)) return;
      try {
        await deleteDoc(doc(db, COLECCION_INVENTARIO, it._docId));
        cerrarModal();
        mostrarAviso(`"${it.nombre}" fue eliminado.`);
      } catch (err) {
        console.error(err);
        mostrarAviso("No se pudo eliminar. Revisa tu conexión o permisos.", true);
      }
    });
  }
}
