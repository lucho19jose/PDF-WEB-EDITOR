<template>
  <!-- ═════════════ Encabezado y pie de página ═════════════ -->
  <q-dialog :model-value="ui.dialog === 'headerFooter'" @update:model-value="(v: boolean) => !v && closeIf('headerFooter')">
    <div class="acro-card dlg wide">
      <div class="acro-card-title">{{ hf.pageNumbers ? 'Agregar números de página' : hf.update ? 'Actualizar encabezado y pie de página' : 'Agregar encabezado y pie de página' }}</div>
      <div class="acro-card-body">
        <div class="cols">
          <div class="col-form">
            <fieldset>
              <legend>Fuente</legend>
              <div class="inline">
                <label class="acro-field">Nombre
                  <select v-model="hf.fontName" class="acro-input"><option v-for="f in baseFonts" :key="f.v" :value="f.v">{{ f.l }}</option></select>
                </label>
                <label class="acro-field">Tamaño
                  <select v-model.number="hf.fontSize" class="acro-input"><option v-for="s in [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24]" :key="s" :value="s">{{ s }}</option></select>
                </label>
                <label class="acro-field">Color <ColorSwatch v-model="hf.color" /></label>
              </div>
            </fieldset>
            <fieldset>
              <legend>Margen (centímetros)</legend>
              <div class="inline">
                <label class="acro-field">Superior <input v-model.number="hf.mTop" type="number" step="0.1" min="0" class="acro-input num" /></label>
                <label class="acro-field">Inferior <input v-model.number="hf.mBottom" type="number" step="0.1" min="0" class="acro-input num" /></label>
                <label class="acro-field">Izquierdo <input v-model.number="hf.mLeft" type="number" step="0.1" min="0" class="acro-input num" /></label>
                <label class="acro-field">Derecho <input v-model.number="hf.mRight" type="number" step="0.1" min="0" class="acro-input num" /></label>
              </div>
            </fieldset>
            <div class="hf-grid">
              <label class="acro-field">Texto del encabezado izquierdo<textarea v-model="hf.hl" class="acro-input ta" @focus="hfFocus = 'hl'" /></label>
              <label class="acro-field">Texto del encabezado central<textarea v-model="hf.hc" class="acro-input ta" @focus="hfFocus = 'hc'" /></label>
              <label class="acro-field">Texto del encabezado derecho<textarea v-model="hf.hr" class="acro-input ta" @focus="hfFocus = 'hr'" /></label>
              <label class="acro-field">Texto del pie de página izquierdo<textarea v-model="hf.fl" class="acro-input ta" @focus="hfFocus = 'fl'" /></label>
              <label class="acro-field">Texto del pie de página central<textarea v-model="hf.fc" class="acro-input ta" @focus="hfFocus = 'fc'" /></label>
              <label class="acro-field">Texto del pie de página derecho<textarea v-model="hf.fr" class="acro-input ta" @focus="hfFocus = 'fr'" /></label>
            </div>
            <div class="inline actions-row">
              <button class="acro-pill outline pill-sm" @click="hfInsert('<<1>>')">Insertar número de página</button>
              <button class="acro-pill outline pill-sm" @click="hfInsert('Página <<1>> de <<n>>')">Página X de N</button>
              <button class="acro-pill outline pill-sm" @click="hfInsert('<<fecha>>')">Insertar fecha</button>
              <label class="acro-field">Iniciar en <input v-model.number="hf.start" type="number" min="1" class="acro-input num" /></label>
            </div>
            <PageRangePicker v-model="hf.pages" subset />
          </div>
          <div class="col-preview">
            <div class="preview-label">Vista previa — página {{ (hf.pages[0] ?? 0) + 1 }}</div>
            <div class="mini-page" :style="previewPageStyle">
              <ThumbImage v-if="docStore.loaded" :page="(hf.pages[0] ?? 0) + 1" :width="200" class="mini-bg" />
              <div v-for="b in hfPreview" :key="b.k" class="mini-txt" :style="b.style">{{ b.text }}</div>
            </div>
          </div>
        </div>
      </div>
      <div class="acro-card-actions">
        <button class="acro-pill outline" @click="close">Cancelar</button>
        <button class="acro-pill primary" :disabled="!hf.pages.length" @click="applyHeaderFooter">Aceptar</button>
      </div>
    </div>
  </q-dialog>

  <!-- ═════════════ Marca de agua ═════════════ -->
  <q-dialog :model-value="ui.dialog === 'watermark'" @update:model-value="(v: boolean) => !v && closeIf('watermark')">
    <div class="acro-card dlg wide">
      <div class="acro-card-title">{{ wm.update ? 'Actualizar marca de agua' : 'Agregar marca de agua' }}</div>
      <div class="acro-card-body">
        <div class="cols">
          <div class="col-form">
            <fieldset>
              <legend>Origen</legend>
              <label class="acro-field">Texto<textarea v-model="wm.text" class="acro-input ta" /></label>
              <div class="inline">
                <label class="acro-field">Fuente
                  <select v-model="wm.fontName" class="acro-input"><option v-for="f in baseFonts" :key="f.v" :value="f.v">{{ f.l }}</option></select>
                </label>
                <label class="acro-field">Tamaño
                  <select v-model="wm.sizeMode" class="acro-input"><option value="auto">Ajustar a la página</option><option value="fixed">Fijo</option></select>
                </label>
                <label v-if="wm.sizeMode === 'fixed'" class="acro-field">Puntos <input v-model.number="wm.fontSize" type="number" min="6" max="400" class="acro-input num" /></label>
                <label v-else class="acro-field">% del ancho <input v-model.number="wm.widthPct" type="number" min="10" max="100" class="acro-input num" /></label>
                <label class="acro-field">Color <ColorSwatch v-model="wm.color" /></label>
              </div>
            </fieldset>
            <fieldset>
              <legend>Aspecto</legend>
              <div class="inline">
                <label class="acro-field">Rotación
                  <select v-model.number="wm.rotation" class="acro-input"><option :value="45">45°</option><option :value="0">Ninguna</option><option :value="-45">-45°</option><option :value="90">90°</option></select>
                </label>
                <label class="acro-field">Opacidad {{ Math.round(wm.opacity * 100) }}%<input v-model.number="wm.opacity" type="range" min="0.05" max="1" step="0.05" /></label>
                <label class="acro-field">Posición vertical
                  <select v-model="wm.vAlign" class="acro-input"><option value="top">Arriba</option><option value="middle">Centro</option><option value="bottom">Abajo</option></select>
                </label>
              </div>
              <div class="inline">
                <label class="acro-check"><input v-model="wm.behind" type="radio" :value="true" /> Detrás de la página</label>
                <label class="acro-check"><input v-model="wm.behind" type="radio" :value="false" /> Delante de la página</label>
              </div>
            </fieldset>
            <PageRangePicker v-model="wm.pages" />
          </div>
          <div class="col-preview">
            <div class="preview-label">Vista previa</div>
            <div class="mini-page" :style="previewPageStyle">
              <ThumbImage v-if="docStore.loaded" :page="(wm.pages[0] ?? 0) + 1" :width="200" class="mini-bg" />
              <div class="mini-wm" :style="wmPreviewStyle">{{ wm.text }}</div>
            </div>
          </div>
        </div>
      </div>
      <div class="acro-card-actions">
        <button class="acro-pill outline" @click="close">Cancelar</button>
        <button class="acro-pill primary" :disabled="!wm.text.trim() || !wm.pages.length" @click="applyWatermark">Aceptar</button>
      </div>
    </div>
  </q-dialog>

  <!-- ═════════════ Fondo ═════════════ -->
  <q-dialog :model-value="ui.dialog === 'background'" @update:model-value="(v: boolean) => !v && closeIf('background')">
    <div class="acro-card dlg">
      <div class="acro-card-title">Agregar fondo</div>
      <div class="acro-card-body">
        <fieldset>
          <legend>Origen</legend>
          <div class="inline">
            <label class="acro-field">Color <ColorSwatch v-model="bg.color" /></label>
            <label class="acro-field">Opacidad {{ Math.round(bg.opacity * 100) }}%<input v-model.number="bg.opacity" type="range" min="0.05" max="1" step="0.05" /></label>
          </div>
        </fieldset>
        <PageRangePicker v-model="bg.pages" />
      </div>
      <div class="acro-card-actions">
        <button class="acro-pill outline" @click="close">Cancelar</button>
        <button class="acro-pill primary" :disabled="!bg.pages.length" @click="applyBackground">Aceptar</button>
      </div>
    </div>
  </q-dialog>

  <!-- ═════════════ Recortar páginas ═════════════ -->
  <q-dialog :model-value="ui.dialog === 'crop'" @update:model-value="(v: boolean) => !v && closeIf('crop')">
    <div class="acro-card dlg">
      <div class="acro-card-title">Establecer cuadros de página</div>
      <div class="acro-card-body">
        <fieldset>
          <legend>Controles de margen (centímetros)</legend>
          <div class="crop-grid">
            <label class="acro-field">Superior <input v-model.number="crop.top" type="number" step="0.1" min="0" class="acro-input num" /></label>
            <label class="acro-field">Inferior <input v-model.number="crop.bottom" type="number" step="0.1" min="0" class="acro-input num" /></label>
            <label class="acro-field">Izquierda <input v-model.number="crop.left" type="number" step="0.1" min="0" class="acro-input num" /></label>
            <label class="acro-field">Derecha <input v-model.number="crop.right" type="number" step="0.1" min="0" class="acro-input num" /></label>
          </div>
          <button class="acro-pill outline pill-sm q-mt-sm" @click="crop.top = crop.bottom = crop.left = crop.right = 0">Restablecer a 0 (quitar el recorte)</button>
        </fieldset>
        <PageRangePicker v-model="crop.pages" :initial="crop.initial" />
      </div>
      <div class="acro-card-actions">
        <button class="acro-pill outline" @click="close">Cancelar</button>
        <button class="acro-pill primary" :disabled="!crop.pages.length" @click="applyCrop">Aceptar</button>
      </div>
    </div>
  </q-dialog>

  <!-- ═════════════ Proteger ═════════════ -->
  <q-dialog :model-value="ui.dialog === 'protect'" @update:model-value="(v: boolean) => !v && closeIf('protect')">
    <div class="acro-card dlg">
      <div class="acro-card-title">Seguridad mediante contraseña: configuración</div>
      <div class="acro-card-body">
        <fieldset>
          <legend>Abrir documento</legend>
          <label class="acro-check"><input v-model="prot.requireOpen" type="checkbox" /> Solicitar una contraseña para abrir el documento</label>
          <div v-if="prot.requireOpen" class="inline q-mt-sm">
            <label class="acro-field">Contraseña de apertura <input v-model="prot.user" type="password" class="acro-input" autocomplete="new-password" /></label>
            <label class="acro-field">Confirmar <input v-model="prot.userConfirm" type="password" class="acro-input" autocomplete="new-password" /></label>
          </div>
        </fieldset>
        <fieldset>
          <legend>Permisos</legend>
          <label class="acro-check"><input v-model="prot.restrict" type="checkbox" /> Restringir la edición y la impresión del documento</label>
          <template v-if="prot.restrict">
            <div class="inline q-mt-sm">
              <label class="acro-field">Contraseña de cambio de permisos <input v-model="prot.owner" type="password" class="acro-input" autocomplete="new-password" /></label>
            </div>
            <div class="perm-grid">
              <label class="acro-check"><input v-model="prot.print" type="checkbox" /> Permitir la impresión</label>
              <label class="acro-check"><input v-model="prot.copy" type="checkbox" /> Permitir copiar texto e imágenes</label>
              <label class="acro-check"><input v-model="prot.modify" type="checkbox" /> Permitir cambios en el documento</label>
              <label class="acro-check"><input v-model="prot.annotate" type="checkbox" /> Permitir comentarios y rellenar formularios</label>
            </div>
          </template>
        </fieldset>
        <div class="note">Se usa cifrado AES de 256 bits. La protección se aplica al guardar el archivo; el documento abierto aquí sigue siendo editable.</div>
        <div v-if="protError" class="error">{{ protError }}</div>
      </div>
      <div class="acro-card-actions">
        <button class="acro-pill outline" @click="close">Cancelar</button>
        <button class="acro-pill outline" @click="applyProtect(false)">Aceptar</button>
        <button class="acro-pill primary" @click="applyProtect(true)">Aceptar y guardar</button>
      </div>
    </div>
  </q-dialog>

  <!-- ═════════════ Propiedades del documento ═════════════ -->
  <q-dialog :model-value="ui.dialog === 'properties'" @update:model-value="(v: boolean) => !v && closeIf('properties')">
    <div class="acro-card dlg">
      <div class="acro-card-title">Propiedades del documento</div>
      <div class="acro-card-body">
        <div class="props-tabs"><span class="on">Descripción</span></div>
        <div class="props">
          <div class="pr"><span>Archivo:</span><b>{{ docStore.fileName }}</b></div>
          <label class="pr"><span>Título:</span><input v-model="meta.Title" class="acro-input" /></label>
          <label class="pr"><span>Autor:</span><input v-model="meta.Author" class="acro-input" /></label>
          <label class="pr"><span>Asunto:</span><input v-model="meta.Subject" class="acro-input" /></label>
          <label class="pr"><span>Palabras clave:</span><input v-model="meta.Keywords" class="acro-input" /></label>
          <div class="acro-hsep" />
          <div class="pr"><span>Creado:</span>{{ pdfDate(meta.CreationDate) }}</div>
          <div class="pr"><span>Modificado:</span>{{ pdfDate(meta.ModDate) }}</div>
          <div class="pr"><span>Aplicación:</span>{{ meta.Creator || '—' }}</div>
          <div class="acro-hsep" />
          <div class="pr"><span>Productor de PDF:</span>{{ meta.Producer || '—' }}</div>
          <div class="pr"><span>Versión de PDF:</span>{{ (meta.format || '').replace('PDF ', '') }}</div>
          <div class="pr"><span>Tamaño del archivo:</span>{{ docStore.fileSizeFormatted }}</div>
          <div class="pr"><span>Tamaño de página:</span>{{ meta.pageSize }}</div>
          <div class="pr"><span>Número de páginas:</span>{{ meta.pageCount }}</div>
          <div class="pr"><span>Seguridad:</span>{{ ui.protection ? 'Contraseña al guardar (AES-256)' : meta.encryption && meta.encryption !== 'None' ? meta.encryption : 'Sin seguridad' }}</div>
          <div class="pr"><span>Firmas digitales:</span>{{ docStore.signatures.length || 'Ninguna' }}</div>
        </div>
        <button class="acro-pill outline pill-sm q-mt-md" @click="meta.Title = meta.Author = meta.Subject = meta.Keywords = ''">
          Quitar información oculta (título, autor, asunto y palabras clave)
        </button>
      </div>
      <div class="acro-card-actions">
        <button class="acro-pill outline" @click="close">Cancelar</button>
        <button class="acro-pill primary" @click="applyProperties">Aceptar</button>
      </div>
    </div>
  </q-dialog>

  <!-- ═════════════ Combinar archivos ═════════════ -->
  <q-dialog :model-value="ui.dialog === 'combine'" @update:model-value="(v: boolean) => !v && closeIf('combine')">
    <div class="acro-card dlg wide">
      <div class="acro-card-title">Combinar archivos</div>
      <div class="acro-card-body">
        <div class="inline">
          <button class="acro-pill primary pill-sm" @click="addCombineFiles"><q-icon name="add" size="16px" /> Agregar archivos</button>
          <label v-if="docStore.loaded" class="acro-check"><input v-model="combineWithOpen" type="checkbox" /> Incluir el documento abierto ({{ docStore.fileName }})</label>
        </div>
        <div class="combine-list" @dragover.prevent @drop.prevent="dropCombine">
          <div v-if="!combineFiles.length && !(combineWithOpen && docStore.loaded)" class="empty">Arrastre archivos PDF o imágenes aquí, o use "Agregar archivos".</div>
          <div v-if="combineWithOpen && docStore.loaded" class="cf-row fixed">
            <q-icon name="picture_as_pdf" color="red-5" size="22px" />
            <span class="cf-name">{{ docStore.fileName }}</span>
            <span class="cf-meta">{{ docStore.totalPages }} pág. · abierto</span>
          </div>
          <div v-for="(f, i) in combineFiles" :key="i + f.name" class="cf-row" draggable="true" @dragstart="cfDrag = i" @dragover.prevent @drop.stop.prevent="cfDrop(i)">
            <q-icon :name="commands.isImage(f) ? 'image' : 'picture_as_pdf'" :color="commands.isImage(f) ? 'teal-4' : 'red-5'" size="22px" />
            <span class="cf-name">{{ f.name }}</span>
            <span class="cf-meta">{{ sizeOf(f.size) }}</span>
            <button class="row-btn" :disabled="i === 0" title="Subir" @click="cfMove(i, -1)"><q-icon name="arrow_upward" size="16px" /></button>
            <button class="row-btn" :disabled="i === combineFiles.length - 1" title="Bajar" @click="cfMove(i, 1)"><q-icon name="arrow_downward" size="16px" /></button>
            <button class="row-btn" title="Quitar" @click="combineFiles.splice(i, 1)"><q-icon name="close" size="16px" /></button>
          </div>
        </div>
      </div>
      <div class="acro-card-actions">
        <button class="acro-pill outline" @click="close">Cancelar</button>
        <button class="acro-pill primary" :disabled="combineCount < 2" @click="applyCombine">Combinar</button>
      </div>
    </div>
  </q-dialog>

  <!-- ═════════════ Crear PDF ═════════════ -->
  <q-dialog :model-value="ui.dialog === 'create'" @update:model-value="(v: boolean) => !v && closeIf('create')">
    <div class="acro-card dlg">
      <div class="acro-card-title">Crear un PDF a partir de cualquier formato</div>
      <div class="acro-card-body">
        <div class="choice-grid">
          <button class="choice" :class="{ on: create.mode === 'images' }" @click="create.mode = 'images'">
            <q-icon name="sym_o_photo_library" size="34px" /><b>Desde imágenes</b><span>JPG, PNG, GIF, BMP, TIFF — una página por imagen</span>
          </button>
          <button class="choice" :class="{ on: create.mode === 'blank' }" @click="create.mode = 'blank'">
            <q-icon name="sym_o_note" size="34px" /><b>Página en blanco</b><span>Un documento nuevo de una página</span>
          </button>
          <button class="choice" :class="{ on: create.mode === 'pdf' }" @click="create.mode = 'pdf'">
            <q-icon name="sym_o_picture_as_pdf" size="34px" /><b>Abrir un PDF</b><span>Para editarlo aquí</span>
          </button>
        </div>
        <div v-if="create.mode === 'blank'" class="inline q-mt-md">
          <label class="acro-field">Tamaño
            <select v-model="create.paper" class="acro-input"><option value="a4">A4 (210 × 297 mm)</option><option value="letter">Carta (8,5 × 11 in)</option><option value="legal">Oficio (8,5 × 14 in)</option></select>
          </label>
          <label class="acro-field">Orientación
            <select v-model="create.orient" class="acro-input"><option value="p">Vertical</option><option value="l">Horizontal</option></select>
          </label>
        </div>
      </div>
      <div class="acro-card-actions">
        <button class="acro-pill outline" @click="close">Cancelar</button>
        <button class="acro-pill primary" @click="applyCreate">{{ create.mode === 'blank' ? 'Crear' : 'Seleccionar archivos…' }}</button>
      </div>
    </div>
  </q-dialog>

  <!-- ═════════════ Exportar ═════════════ -->
  <q-dialog :model-value="ui.dialog === 'export'" @update:model-value="(v: boolean) => !v && closeIf('export')">
    <div class="acro-card dlg">
      <div class="acro-card-title">Exportar el PDF a cualquier formato</div>
      <div class="acro-card-body">
        <div class="formats">
          <label v-for="f in exportFormats" :key="f.v" class="fmt" :class="{ on: exp.format === f.v }">
            <input v-model="exp.format" type="radio" :value="f.v" />
            <q-icon :name="f.icon" size="26px" :style="{ color: f.color }" />
            <span><b>{{ f.l }}</b><small>{{ f.d }}</small></span>
          </label>
        </div>
        <div v-if="exp.format === 'png' || exp.format === 'jpeg'" class="q-mt-md">
          <div class="inline">
            <label class="acro-field">Resolución
              <select v-model.number="exp.dpi" class="acro-input"><option :value="72">72 ppp</option><option :value="96">96 ppp</option><option :value="150">150 ppp</option><option :value="300">300 ppp</option><option :value="600">600 ppp</option></select>
            </label>
            <label v-if="exp.format === 'jpeg'" class="acro-field">Calidad {{ exp.quality }}<input v-model.number="exp.quality" type="range" min="30" max="100" step="5" /></label>
          </div>
          <PageRangePicker v-model="exp.pages" class="q-mt-sm" />
        </div>
      </div>
      <div class="acro-card-actions">
        <button class="acro-pill outline" @click="close">Cancelar</button>
        <button class="acro-pill primary" @click="applyExport">Exportar</button>
      </div>
    </div>
  </q-dialog>

  <!-- ═════════════ Vínculo ═════════════ -->
  <q-dialog :model-value="ui.dialog === 'link'" @update:model-value="(v: boolean) => !v && closeIf('link')">
    <div class="acro-card dlg">
      <template v-if="ui.dialogArgs?.list">
        <div class="acro-card-title">Vínculos de la página {{ docStore.currentPage }}</div>
        <div class="acro-card-body">
          <div v-if="!links.length" class="empty">Esta página no tiene vínculos.</div>
          <div v-for="(l, i) in links" :key="i" class="cf-row">
            <q-icon :name="l.external ? 'public' : 'description'" size="20px" />
            <span class="cf-name">{{ l.external ? l.uri : `Página ${l.page}` }}</span>
            <button class="row-btn" title="Eliminar" @click="deleteLink(i)"><q-icon name="delete" size="16px" /></button>
          </div>
        </div>
        <div class="acro-card-actions"><button class="acro-pill primary" @click="close">Cerrar</button></div>
      </template>
      <template v-else>
        <div class="acro-card-title">Crear vínculo</div>
        <div class="acro-card-body">
          <fieldset>
            <legend>Acción del vínculo</legend>
            <label class="acro-check"><input v-model="link.kind" type="radio" value="uri" /> Abrir una página web</label>
            <input v-if="link.kind === 'uri'" v-model="link.uri" class="acro-input full q-mt-xs" placeholder="https://" />
            <label class="acro-check q-mt-sm"><input v-model="link.kind" type="radio" value="page" /> Ir a una vista de página</label>
            <label v-if="link.kind === 'page'" class="acro-field q-mt-xs">Página <input v-model.number="link.page" type="number" min="1" :max="docStore.totalPages" class="acro-input num" /></label>
          </fieldset>
        </div>
        <div class="acro-card-actions">
          <button class="acro-pill outline" @click="close">Cancelar</button>
          <button class="acro-pill primary" :disabled="link.kind === 'uri' ? !link.uri.trim() : !link.page" @click="applyLink">Aceptar</button>
        </div>
      </template>
    </div>
  </q-dialog>

  <!-- ═════════════ Firma ═════════════ -->
  <q-dialog :model-value="ui.dialog === 'signature'" @update:model-value="(v: boolean) => !v && closeIf('signature')">
    <div class="acro-card dlg">
      <div class="acro-card-title">{{ ui.dialogArgs?.kind === 'initials' ? 'Iniciales' : 'Firma' }}</div>
      <div class="acro-card-body">
        <SignaturePad ref="sigPad" :kind="ui.dialogArgs?.kind === 'initials' ? 'initials' : 'signature'" />
      </div>
      <div class="acro-card-actions">
        <button class="acro-pill outline" @click="close">Cancelar</button>
        <button class="acro-pill primary" @click="applySignature">Aplicar</button>
      </div>
    </div>
  </q-dialog>

  <!-- ═════════════ Dividir ═════════════ -->
  <q-dialog :model-value="ui.dialog === 'split'" @update:model-value="(v: boolean) => !v && closeIf('split')">
    <div class="acro-card dlg">
      <div class="acro-card-title">Dividir documento</div>
      <div class="acro-card-body">
        <fieldset>
          <legend>Dividir por</legend>
          <label class="acro-check"><input v-model="split.mode" type="radio" value="every" /> Número de páginas:
            <input v-model.number="split.every" type="number" min="1" :max="Math.max(1, docStore.totalPages - 1)" class="acro-input num" @focus="split.mode = 'every'" />
          </label>
          <label class="acro-check q-mt-sm"><input v-model="split.mode" type="radio" value="at" /> Antes de las páginas:
            <input v-model="split.at" class="acro-input" placeholder="p. ej. 4, 9" @focus="split.mode = 'at'" />
          </label>
        </fieldset>
        <div class="note">Se descargará un archivo .zip con {{ splitCount }} documento(s). El documento abierto no cambia.</div>
      </div>
      <div class="acro-card-actions">
        <button class="acro-pill outline" @click="close">Cancelar</button>
        <button class="acro-pill primary" :disabled="splitCount < 2" @click="applySplit">Dividir</button>
      </div>
    </div>
  </q-dialog>

  <!-- ═════════════ Extraer ═════════════ -->
  <q-dialog :model-value="ui.dialog === 'extract'" @update:model-value="(v: boolean) => !v && closeIf('extract')">
    <div class="acro-card dlg">
      <div class="acro-card-title">Extraer páginas</div>
      <div class="acro-card-body">
        <PageRangePicker v-model="extract.pages" initial="selected" />
        <label class="acro-check"><input v-model="extract.deleteAfter" type="checkbox" /> Eliminar las páginas después de extraerlas</label>
        <label class="acro-check q-mt-sm"><input v-model="extract.separate" type="checkbox" /> Extraer las páginas como archivos independientes</label>
      </div>
      <div class="acro-card-actions">
        <button class="acro-pill outline" @click="close">Cancelar</button>
        <button class="acro-pill primary" :disabled="!extract.pages.length" @click="applyExtract">Extraer</button>
      </div>
    </div>
  </q-dialog>

  <!-- ═════════════ Insertar páginas ═════════════ -->
  <q-dialog :model-value="ui.dialog === 'insertPages'" @update:model-value="(v: boolean) => !v && closeIf('insertPages')">
    <div class="acro-card dlg">
      <div class="acro-card-title">{{ ins.mode === 'blank' ? 'Insertar página en blanco' : 'Insertar páginas' }}</div>
      <div class="acro-card-body">
        <div class="inline">
          <label class="acro-check"><input v-model="ins.mode" type="radio" value="file" /> Desde un archivo</label>
          <label class="acro-check"><input v-model="ins.mode" type="radio" value="blank" /> Página en blanco</label>
        </div>
        <fieldset class="q-mt-md">
          <legend>Ubicación</legend>
          <div class="inline">
            <select v-model="ins.where" class="acro-input"><option value="after">Después de</option><option value="before">Antes de</option></select>
            <select v-model="ins.ref" class="acro-input"><option value="first">Primera página</option><option value="last">Última página</option><option value="page">Página</option></select>
            <input v-if="ins.ref === 'page'" v-model.number="ins.page" type="number" min="1" :max="docStore.totalPages" class="acro-input num" />
            <span class="note">de {{ docStore.totalPages }}</span>
          </div>
        </fieldset>
      </div>
      <div class="acro-card-actions">
        <button class="acro-pill outline" @click="close">Cancelar</button>
        <button class="acro-pill primary" @click="applyInsert">{{ ins.mode === 'blank' ? 'Insertar' : 'Seleccionar archivo…' }}</button>
      </div>
    </div>
  </q-dialog>

  <!-- ═════════════ Atajos / ayuda ═════════════ -->
  <q-dialog :model-value="ui.dialog === 'shortcuts'" @update:model-value="(v: boolean) => !v && closeIf('shortcuts')">
    <div class="acro-card dlg">
      <div class="acro-card-title">Métodos abreviados de teclado</div>
      <div class="acro-card-body">
        <table class="keys">
          <tr v-for="k in shortcuts" :key="k[0]"><td><kbd>{{ k[0] }}</kbd></td><td>{{ k[1] }}</td></tr>
        </table>
      </div>
      <div class="acro-card-actions"><button class="acro-pill primary" @click="close">Cerrar</button></div>
    </div>
  </q-dialog>

  <!-- ═════════════ Acerca de ═════════════ -->
  <q-dialog :model-value="ui.dialog === 'about'" @update:model-value="(v: boolean) => !v && closeIf('about')">
    <div class="acro-card dlg">
      <div class="acro-card-title">PDF Editor Pro</div>
      <div class="acro-card-body about">
        <AcroIcon name="create" color="#ff7b82" :size="56" />
        <p>Editor de PDF que modifica el contenido real del documento — texto, imágenes y páginas — con una interfaz familiar para quienes usan Acrobat.</p>
        <p class="note">No necesita una cuenta: todo se procesa en su equipo y los archivos no se suben a ningún servidor. Solo el OCR de Mistral y el asistente envían datos, y siempre piden permiso antes.</p>
        <p class="note">Motor de edición: MuPDF (AGPL). Renderizado: PDF.js.</p>
      </div>
      <div class="acro-card-actions"><button class="acro-pill primary" @click="close">Aceptar</button></div>
    </div>
  </q-dialog>
</template>

<script setup lang="ts">
import { reactive, ref, computed, watch, inject, nextTick } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useEditorStore } from '@/stores/editor'
import { useUiStore } from '@/stores/ui'
import { hexToRgb01 } from '@/utils/color'
import { parsePageRange } from '@/composables/useAcroCommands'
import ColorSwatch from '@/components/toolbar/ColorSwatch.vue'
import PageRangePicker from './PageRangePicker.vue'
import SignaturePad from './SignaturePad.vue'
import ThumbImage from './ThumbImage.vue'
import AcroIcon from './AcroIcon.vue'
import type { AcroShell } from './acroShell'

const docStore = useDocumentStore()
const editorStore = useEditorStore()
const ui = useUiStore()
const shell = inject<AcroShell>('acroShell')!
const pickFiles = inject<(accept: string, multiple: boolean) => Promise<File[]>>('pickFiles')!
const commands = shell.commands
const CM = 72 / 2.54

function close() { ui.closeDialog() }
/**
 * A dialog's own dismissal closes it only while it is still the one open: its
 * hide transition ends after the next dialog may already have been asked for,
 * and closing unconditionally shut that one before it appeared.
 */
function closeIf(name: string) { if (ui.dialog === name) ui.closeDialog() }

const baseFonts = [
  { v: 'Helvetica', l: 'Helvetica' }, { v: 'Helvetica-Bold', l: 'Helvetica Bold' },
  { v: 'Times-Roman', l: 'Times' }, { v: 'Times-Bold', l: 'Times Bold' },
  { v: 'Courier', l: 'Courier' }, { v: 'Courier-Bold', l: 'Courier Bold' }
]

// Page geometry of the first page, for the previews.
const pageW = ref(612), pageH = ref(792)
const previewPageStyle = computed(() => ({ width: '200px', height: `${Math.round(200 * pageH.value / pageW.value)}px` }))
const pdfEngine = inject<any>('pdfEngine')!
async function measurePage(pageIndex: number) {
  const s = await pdfEngine.getPageSize(pageIndex).catch(() => null)
  if (s) { pageW.value = s.width; pageH.value = s.height }
}

// ═════════════ Header / footer ═════════════
const hf = reactive({
  update: false, pageNumbers: false,
  fontName: 'Helvetica', fontSize: 10, color: '#000000',
  mTop: 1.3, mBottom: 1.3, mLeft: 2.5, mRight: 2.5,
  hl: '', hc: '', hr: '', fl: '', fc: '', fr: '',
  start: 1, pages: [] as number[]
})
const hfFocus = ref<'hl' | 'hc' | 'hr' | 'fl' | 'fc' | 'fr'>('fr')
function hfInsert(token: string) {
  const k = hfFocus.value
  hf[k] = hf[k] ? `${hf[k]} ${token}` : token
}
const hfPreview = computed(() => {
  const k = 200 / pageW.value
  const date = new Date().toLocaleDateString('es')
  const exp = (t: string) => t.replace(/<<1>>/g, String(hf.start)).replace(/<<n>>/g, String(docStore.totalPages)).replace(/<<fecha>>/g, date)
  const font = `${Math.max(4, hf.fontSize * k)}px ${hf.fontName.startsWith('Times') ? 'Times New Roman, serif' : hf.fontName.startsWith('Courier') ? 'Courier New, monospace' : 'Arial, sans-serif'}`
  const out: { k: string; text: string; style: Record<string, string> }[] = []
  const place = (key: string, text: string, where: 'left' | 'center' | 'right', top: boolean) => {
    if (!text.trim()) return
    const style: Record<string, string> = { font, color: hf.color, fontWeight: hf.fontName.includes('Bold') ? '700' : '400' }
    if (top) style.top = `${hf.mTop * CM * k}px`; else style.bottom = `${hf.mBottom * CM * k}px`
    if (where === 'left') style.left = `${hf.mLeft * CM * k}px`
    else if (where === 'right') style.right = `${hf.mRight * CM * k}px`
    else { style.left = '0'; style.right = '0'; style.textAlign = 'center' }
    out.push({ k: key, text: exp(text), style })
  }
  place('hl', hf.hl, 'left', true); place('hc', hf.hc, 'center', true); place('hr', hf.hr, 'right', true)
  place('fl', hf.fl, 'left', false); place('fc', hf.fc, 'center', false); place('fr', hf.fr, 'right', false)
  return out
})
async function applyHeaderFooter() {
  const pages = [...hf.pages]
  close()
  await commands.headerFooter({
    pages,
    header: { left: hf.hl, center: hf.hc, right: hf.hr },
    footer: { left: hf.fl, center: hf.fc, right: hf.fr },
    fontName: hf.fontName, fontSize: hf.fontSize, color: hexToRgb01(hf.color),
    margins: { top: hf.mTop * CM, bottom: hf.mBottom * CM, left: hf.mLeft * CM, right: hf.mRight * CM },
    startNumber: hf.start || 1,
    date: new Date().toLocaleDateString('es')
  })
}

// ═════════════ Watermark ═════════════
const wm = reactive({
  update: false, text: 'CONFIDENCIAL', fontName: 'Helvetica-Bold', sizeMode: 'auto' as 'auto' | 'fixed',
  fontSize: 72, widthPct: 70, color: '#ff0000', opacity: 0.3, rotation: 45, vAlign: 'middle' as 'top' | 'middle' | 'bottom',
  behind: false, pages: [] as number[]
})
const wmPreviewStyle = computed(() => {
  const k = 200 / pageW.value
  const size = wm.sizeMode === 'fixed' ? wm.fontSize * k : (200 * wm.widthPct / 100) / Math.max(1, wm.text.length * 0.62)
  const top = wm.vAlign === 'top' ? '20%' : wm.vAlign === 'bottom' ? '80%' : '50%'
  return {
    top, fontSize: `${Math.max(4, size)}px`, color: wm.color, opacity: String(wm.opacity),
    transform: `translate(-50%, -50%) rotate(${-wm.rotation}deg)`,
    fontFamily: wm.fontName.startsWith('Times') ? 'Times New Roman, serif' : wm.fontName.startsWith('Courier') ? 'Courier New, monospace' : 'Arial, sans-serif',
    fontWeight: wm.fontName.includes('Bold') ? '700' : '400',
    zIndex: wm.behind ? '0' : '2'
  }
})
async function applyWatermark() {
  const pages = [...wm.pages]
  close()
  await commands.watermark({
    pages, text: wm.text, fontName: wm.fontName,
    widthFraction: wm.sizeMode === 'auto' ? wm.widthPct / 100 : undefined,
    fontSize: wm.fontSize, color: hexToRgb01(wm.color), opacity: wm.opacity,
    rotation: wm.rotation, behind: wm.behind, vAlign: wm.vAlign
  })
}

// ═════════════ Background ═════════════
const bg = reactive({ color: '#fff8dc', opacity: 1, pages: [] as number[] })
async function applyBackground() {
  const pages = [...bg.pages]
  close()
  await commands.background({ pages, color: hexToRgb01(bg.color), opacity: bg.opacity })
}

// ═════════════ Crop ═════════════
const crop = reactive({ top: 0, bottom: 0, left: 0, right: 0, pages: [] as number[], initial: 'current' as 'all' | 'current' | 'selected' })
async function applyCrop() {
  const pages = [...crop.pages]
  const m = { top: crop.top * CM, bottom: crop.bottom * CM, left: crop.left * CM, right: crop.right * CM }
  close()
  await commands.cropPages(pages, m)
  if (editorStore.currentTool === 'crop') editorStore.setTool('edit')
}

// ═════════════ Protect ═════════════
const prot = reactive({ requireOpen: true, user: '', userConfirm: '', restrict: false, owner: '', print: true, copy: false, modify: false, annotate: true })
const protError = ref('')
async function applyProtect(saveNow: boolean) {
  protError.value = ''
  if (prot.requireOpen && !prot.user) { protError.value = 'Escriba la contraseña de apertura'; return }
  if (prot.requireOpen && prot.user !== prot.userConfirm) { protError.value = 'Las contraseñas no coinciden'; return }
  if (/[,=\s]/.test(prot.user + prot.owner)) { protError.value = 'Las contraseñas no pueden contener espacios, comas ni el signo ='; return }
  if (!prot.requireOpen && !prot.restrict) { ui.protection = null; close(); return }
  if (prot.restrict && !prot.owner) { protError.value = 'Escriba la contraseña de cambio de permisos'; return }
  if (prot.restrict && prot.owner === prot.user) { protError.value = 'La contraseña de permisos debe ser distinta de la de apertura'; return }
  ui.protection = {
    userPassword: prot.requireOpen ? prot.user : '',
    ownerPassword: prot.restrict ? prot.owner : '',
    permissions: prot.restrict
      ? { print: prot.print, copy: prot.copy, modify: prot.modify, annotate: prot.annotate }
      : { print: true, copy: true, modify: true, annotate: true }
  }
  close()
  commands.say('Seguridad configurada: se aplicará al guardar el archivo')
  if (saveNow) await shell.save()
}

// ═════════════ Properties ═════════════
const meta = reactive<Record<string, string>>({})
function pdfDate(d?: string) {
  const m = /D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?/.exec(d || '')
  if (!m) return d || '—'
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)).toLocaleString('es')
}
async function applyProperties() {
  const values = { Title: meta.Title ?? '', Author: meta.Author ?? '', Subject: meta.Subject ?? '', Keywords: meta.Keywords ?? '' }
  close()
  await commands.setMetadata(values)
}

// ═════════════ Combine ═════════════
const combineFiles = ref<File[]>([])
const combineWithOpen = ref(false)
const cfDrag = ref<number | null>(null)
const combineCount = computed(() => combineFiles.value.length + (combineWithOpen.value && docStore.loaded ? 1 : 0))
async function addCombineFiles() {
  const files = await pickFiles('application/pdf,.pdf,image/*', true)
  combineFiles.value.push(...files)
}
function dropCombine(e: DragEvent) { combineFiles.value.push(...[...(e.dataTransfer?.files ?? [])]) }
function cfMove(i: number, d: number) {
  const a = combineFiles.value
  const [f] = a.splice(i, 1)
  a.splice(i + d, 0, f)
}
function cfDrop(i: number) {
  if (cfDrag.value === null || cfDrag.value === i) return
  const a = combineFiles.value
  const [f] = a.splice(cfDrag.value, 1)
  a.splice(i, 0, f)
  cfDrag.value = null
}
async function applyCombine() {
  const files = [...combineFiles.value]
  if (combineWithOpen.value && docStore.loaded) {
    const bytes = await pdfEngine.saveDocument()
    files.unshift(new File([bytes], docStore.fileName || 'documento.pdf', { type: 'application/pdf' }))
  }
  close()
  await commands.combine(files)
}
function sizeOf(b: number) { return b < 1048576 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(1)} MB` }

// ═════════════ Create ═════════════
const create = reactive({ mode: 'images' as 'images' | 'blank' | 'pdf', paper: 'a4', orient: 'p' })
async function applyCreate() {
  if (create.mode === 'pdf') { close(); shell.openFile(); return }
  if (create.mode === 'blank') {
    const sizes: Record<string, [number, number]> = { a4: [595.28, 841.89], letter: [612, 792], legal: [612, 1008] }
    let [w, h] = sizes[create.paper]
    if (create.orient === 'l') [w, h] = [h, w]
    close()
    await commands.createPdf([], { width: w, height: h })
    return
  }
  const files = await pickFiles('image/png,image/jpeg,image/gif,image/bmp,image/tiff,image/webp', true)
  if (!files.length) return
  close()
  await commands.createPdf(files)
}

// ═════════════ Export ═════════════
const exportFormats = [
  { v: 'docx', l: 'Microsoft Word', d: 'Documento de Word (*.docx)', icon: 'sym_o_description', color: '#4b9cf5' },
  { v: 'png', l: 'Imagen PNG', d: 'Una imagen por página (*.png)', icon: 'sym_o_image', color: '#26c0c7' },
  { v: 'jpeg', l: 'Imagen JPEG', d: 'Una imagen por página (*.jpg)', icon: 'sym_o_photo', color: '#26c0c7' },
  { v: 'txt', l: 'Texto', d: 'Texto sin formato (*.txt)', icon: 'sym_o_article', color: '#cfcfcf' },
  { v: 'html', l: 'Página web HTML', d: 'HTML con el diseño de la página (*.html)', icon: 'sym_o_code', color: '#f5a623' }
] as const
const exp = reactive({ format: 'docx' as typeof exportFormats[number]['v'], dpi: 150, quality: 90, pages: [] as number[] })
async function applyExport() {
  const opts = { dpi: exp.dpi, quality: exp.quality, pages: [...exp.pages] }
  const fmt = exp.format
  close()
  await commands.exportAs(fmt, opts)
}

// ═════════════ Link ═════════════
const link = reactive({ kind: 'uri' as 'uri' | 'page', uri: 'https://', page: 1 })
const links = ref<{ rect: number[]; uri: string; external: boolean; page: number | null }[]>([])
async function loadLinks() { links.value = await commands.listLinks(docStore.currentPage - 1).catch(() => []) }
async function deleteLink(i: number) { await commands.deleteLink(docStore.currentPage - 1, i); await loadLinks() }
async function applyLink() {
  const a = ui.dialogArgs
  if (!a?.rect) { close(); return }
  let uri = link.uri.trim()
  if (link.kind === 'uri' && !/^[a-z]+:/i.test(uri)) uri = 'https://' + uri
  const target = link.kind === 'uri' ? { uri } : { page: link.page }
  close()
  await commands.addLink(a.pageIndex, a.rect, target)
}

// ═════════════ Signature ═════════════
const sigPad = ref<InstanceType<typeof SignaturePad> | null>(null)
async function applySignature() {
  const url = await sigPad.value?.result()
  if (!url) { commands.say('Escriba, dibuje o elija una imagen de su firma'); return }
  const kind = ui.dialogArgs?.kind === 'initials' ? 'initials' : 'signature'
  if (kind === 'initials') ui.initialsImage = url; else ui.signatureImage = url
  close()
  editorStore.signKind = kind
  editorStore.setTool('sign')
  editorStore.setStatus('Haga clic en la página donde desea colocar la firma')
}

// ═════════════ Split ═════════════
const split = reactive({ mode: 'every' as 'every' | 'at', every: 1, at: '' })
const splitCount = computed(() => {
  const n = docStore.totalPages
  if (split.mode === 'every') return split.every > 0 ? Math.ceil(n / split.every) : 0
  return parsePageRange(split.at, n).filter(i => i > 0).length + 1
})
async function applySplit() {
  const n = docStore.totalPages
  const opts = split.mode === 'every' ? { every: split.every } : { at: parsePageRange(split.at, n).filter(i => i > 0) }
  close()
  await commands.splitDocument(opts)
}

// ═════════════ Extract ═════════════
const extract = reactive({ pages: [] as number[], deleteAfter: false, separate: false })
async function applyExtract() {
  const pages = [...extract.pages]
  const opts = { deleteAfter: extract.deleteAfter, separate: extract.separate }
  close()
  await commands.extractPages(pages, opts)
}

// ═════════════ Insert pages ═════════════
const ins = reactive({ mode: 'file' as 'file' | 'blank', where: 'after' as 'after' | 'before', ref: 'page' as 'first' | 'last' | 'page', page: 1 })
function insertIndex(): number {
  const n = docStore.totalPages
  const p = ins.ref === 'first' ? 1 : ins.ref === 'last' ? n : Math.max(1, Math.min(n, ins.page || 1))
  return ins.where === 'after' ? p : p - 1
}
async function applyInsert() {
  const at = insertIndex()
  if (ins.mode === 'blank') { close(); await commands.insertBlank(at); return }
  const files = await pickFiles('application/pdf,.pdf,image/*', true)
  if (!files.length) return
  close()
  let pos = at
  for (const f of files) {
    const before = docStore.totalPages
    await commands.insertFile(f, pos)
    pos += docStore.totalPages - before
  }
}

// ═════════════ Shortcuts ═════════════
const shortcuts = [
  ['Ctrl+O', 'Abrir un archivo'], ['Ctrl+S', 'Guardar'], ['Mayús+Ctrl+S', 'Guardar como'], ['Ctrl+P', 'Imprimir'],
  ['Ctrl+W', 'Cerrar el archivo'], ['Ctrl+D', 'Propiedades del documento'], ['Ctrl+Z / Ctrl+Y', 'Deshacer / Rehacer'],
  ['Ctrl+F', 'Buscar'], ['Ctrl++ / Ctrl+-', 'Acercar / Alejar'], ['Ctrl+0', 'Ajustar página'], ['Ctrl+1', 'Tamaño real'],
  ['Ctrl+2', 'Ajustar anchura'], ['Ctrl+H', 'Modo de lectura'], ['F4', 'Panel de navegación'], ['Mayús+F4', 'Panel derecho'],
  ['Inicio / Fin', 'Primera / última página'], ['Re Pág / Av Pág', 'Página anterior / siguiente'],
  ['V', 'Herramienta Seleccionar'], ['Barra espaciadora', 'Mano (mantener pulsada)'], ['E', 'Editar texto e imágenes'],
  ['T', 'Agregar texto'], ['H', 'Resaltar'], ['D', 'Dibujar'], ['R / O', 'Rectángulo / óvalo'], ['Supr', 'Eliminar la selección']
]

// ═════════════ initialise each dialog as it opens ═════════════
watch(() => ui.dialog, async d => {
  const a = ui.dialogArgs ?? {}
  if (!docStore.loaded && !['combine', 'create', 'about', 'shortcuts'].includes(d ?? '')) return
  if (d === 'headerFooter') {
    hf.update = !!a.update; hf.pageNumbers = !!a.pageNumbers
    if (a.pageNumbers) { hf.hl = hf.hc = hf.hr = hf.fl = hf.fc = ''; hf.fr = 'Página <<1>> de <<n>>'; hfFocus.value = 'fr' }
    await measurePage(0)
  } else if (d === 'watermark') {
    wm.update = !!a.update
    await measurePage(0)
  } else if (d === 'crop') {
    crop.initial = a.pages?.length > 1 ? 'selected' : 'current'
    if (a.pages?.length) ui.selectedPages = [...a.pages]
    if (a.rect && a.pdfW && a.pdfH) {
      const [x0, y0, x1, y1] = a.rect
      const f = (v: number) => Math.max(0, Math.round(v / CM * 100) / 100)
      crop.left = f(Math.min(x0, x1)); crop.top = f(Math.min(y0, y1))
      crop.right = f(a.pdfW - Math.max(x0, x1)); crop.bottom = f(a.pdfH - Math.max(y0, y1))
    } else {
      const page = a.pages?.[0] ?? docStore.currentPage - 1
      const m = await pdfEngine.acro('cropOf', { pageIndex: page }).catch(() => null)
      const f = (v: number) => Math.round((v || 0) / CM * 100) / 100
      crop.top = f(m?.top); crop.bottom = f(m?.bottom); crop.left = f(m?.left); crop.right = f(m?.right)
    }
  } else if (d === 'protect') {
    protError.value = ''
    if (ui.protection) {
      prot.requireOpen = !!ui.protection.userPassword
      prot.user = prot.userConfirm = ui.protection.userPassword
      prot.restrict = !!ui.protection.ownerPassword
      prot.owner = ui.protection.ownerPassword
      Object.assign(prot, ui.protection.permissions)
    }
    if (a.restrict) { prot.restrict = true; if (!ui.protection) { prot.requireOpen = false; prot.print = true; prot.copy = true; prot.modify = false; prot.annotate = false } }
  } else if (d === 'properties') {
    const m = await commands.getMetadata().catch(() => ({}))
    for (const k of Object.keys(meta)) delete meta[k]
    Object.assign(meta, m)
    if (a.sanitize) meta.Title = meta.Author = meta.Subject = meta.Keywords = ''
  } else if (d === 'combine') {
    combineFiles.value = []
    combineWithOpen.value = docStore.loaded
  } else if (d === 'export') {
    if (a.format) exp.format = a.format
  } else if (d === 'link') {
    link.page = docStore.currentPage
    if (a.list) await loadLinks()
  } else if (d === 'insertPages') {
    ins.mode = a.mode === 'blank' ? 'blank' : 'file'
    ins.where = 'after'
    ins.ref = 'page'
    ins.page = a.at ?? (ui.selectedPages.length ? Math.max(...ui.selectedPages) + 1 : docStore.currentPage)
  } else if (d === 'split') {
    split.every = Math.max(1, Math.ceil(docStore.totalPages / 2))
  }
  await nextTick()
})
</script>

<style scoped>
.dlg { width: 520px; max-width: 94vw; max-height: 92vh; overflow-y: auto; }
.dlg.wide { width: 860px; }
.cols { display: flex; gap: 24px; }
.col-form { flex: 1; min-width: 0; }
.col-preview { width: 210px; flex: none; }
.preview-label { font-size: 12px; color: #bdbdbd; margin-bottom: 6px; }
.mini-page { position: relative; background: #fff; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5); overflow: hidden; }
.mini-bg { position: absolute; inset: 0; opacity: 0.85; }
.mini-txt { position: absolute; white-space: nowrap; line-height: 1; z-index: 1; }
.mini-wm { position: absolute; left: 50%; white-space: nowrap; line-height: 1; }
.inline { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px; }
.inline + .inline { margin-top: 10px; }
.num { width: 76px; }
.full { width: 100%; }
.ta { height: 44px; padding: 4px 6px; resize: vertical; font-family: inherit; }
.hf-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 10px; }
.actions-row { margin-bottom: 12px; }
.acro-pill.pill-sm { height: 26px; font-size: 12px; padding: 0 12px; font-weight: 600; }
.crop-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
.perm-grid { display: grid; grid-template-columns: 1fr; gap: 6px; margin-top: 10px; }
.note { color: #a8a8a8; font-size: 12px; line-height: 1.5; }
.error { color: #ff8a8a; margin-top: 8px; font-size: 13px; }
.props-tabs { border-bottom: 1px solid #5a5a5a; margin-bottom: 12px; }
.props-tabs span { display: inline-block; padding: 6px 12px; border-bottom: 2px solid #fff; color: #fff; font-size: 13px; }
.props { display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
.pr { display: flex; align-items: center; gap: 10px; }
.pr > span { width: 140px; color: #bdbdbd; flex: none; text-align: right; }
.pr .acro-input { flex: 1; }
.combine-list { margin-top: 14px; min-height: 180px; border: 1px dashed #666; border-radius: 4px; padding: 6px; }
.empty { color: #9a9a9a; padding: 40px 10px; text-align: center; }
.cf-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 3px; background: #3d3d3d; margin-bottom: 4px; cursor: grab; }
.cf-row.fixed { cursor: default; background: #384252; }
.cf-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cf-meta { color: #a0a0a0; font-size: 12px; }
.row-btn { border: 0; background: transparent; color: #bbb; cursor: pointer; border-radius: 3px; display: inline-flex; padding: 3px; }
.row-btn:hover:not(:disabled) { background: #555; color: #fff; }
.row-btn:disabled { opacity: 0.3; }
.choice-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.choice { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 16px 10px; border: 1px solid #5a5a5a; border-radius: 4px; background: #3b3b3b; color: #e6e6e6; cursor: pointer; font: inherit; text-align: center; }
.choice span { font-size: 11px; color: #a8a8a8; }
.choice.on { border-color: var(--acro-blue); background: #33405a; }
.formats { display: flex; flex-direction: column; gap: 6px; }
.fmt { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border: 1px solid #555; border-radius: 4px; cursor: pointer; }
.fmt.on { border-color: var(--acro-blue); background: #33405a; }
.fmt span { display: flex; flex-direction: column; }
.fmt small { color: #a8a8a8; font-size: 11px; }
.fmt input { accent-color: var(--acro-blue); }
.keys { width: 100%; border-collapse: collapse; font-size: 13px; }
.keys td { padding: 5px 6px; border-bottom: 1px solid #484848; }
kbd { background: #252525; border: 1px solid #555; border-radius: 3px; padding: 1px 6px; font-family: inherit; font-size: 12px; white-space: nowrap; }
.about { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 6px; }
.about p { margin: 6px 0; line-height: 1.5; }
</style>
