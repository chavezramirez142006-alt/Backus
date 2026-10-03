import { Component, OnInit, signal, computed, inject, PLATFORM_ID } from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { SwUpdate } from '@angular/service-worker';

export interface Producto {
  id: string;
  nombre: string;
  marca: 'Cristal' | 'Pilsen' | 'Cusqueña' | 'San Mateo';
  categoria: string;
  presentacion: string;
  precio: number;
  stock: number;
  icono: string;
  destacado: boolean;
}

export interface ItemCarrito {
  producto: Producto;
  cantidad: number;
}

export interface Pedido {
  id: string;
  fecha: string;
  cliente: string;
  zona: string;
  items: { nombre: string; cantidad: number; subtotal: number }[];
  total: number;
  estado: 'pendiente' | 'sincronizado';
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit {
  protected readonly title = signal('taller-pwa');

  // Inyección de servicios
  private http = inject(HttpClient);
  private platformId = inject(PLATFORM_ID);
  private swUpdate = inject(SwUpdate, { optional: true });

  // Estado de la PWA y Conectividad
  isOnline = signal<boolean>(true);
  simulatedOffline = signal<boolean>(false);
  swActivo = signal<boolean>(false);
  fraseDinamica = signal<string>('Cargando datos dinámicos...');

  // Catálogo y filtros
  productos = signal<Producto[]>([]);
  marcaSeleccionada = signal<string>('Todas');
  marcas = ['Todas', 'Cristal', 'Pilsen', 'Cusqueña', 'San Mateo'];

  // Carrito de compras
  carrito = signal<ItemCarrito[]>([]);
  mostrarCarrito = signal<boolean>(false);

  // Formulario de Pedido
  nombreCliente = 'Bodega Los Amigos';
  zonaRuta = 'Ruta 14 - Lima Norte';

  // Historial de Pedidos y sincronización offline (IndexedDB / LocalStorage)
  pedidos = signal<Pedido[]>([]);
  notificacionPush = signal<{ visible: boolean; titulo: string; mensaje: string }>({
    visible: false,
    titulo: '',
    mensaje: ''
  });

  // Notificación de nueva versión disponible (SW)
  nuevaVersionDisponible = signal<boolean>(false);

  // Computados
  productosFiltrados = computed(() => {
    const marca = this.marcaSeleccionada();
    const prods = this.productos();
    if (marca === 'Todas') return prods;
    return prods.filter(p => p.marca === marca);
  });

  totalItemsCarrito = computed(() => {
    return this.carrito().reduce((acc, item) => acc + item.cantidad, 0);
  });

  totalPrecioCarrito = computed(() => {
    return this.carrito().reduce((acc, item) => acc + (item.producto.precio * item.cantidad), 0);
  });

  pedidosPendientesCount = computed(() => {
    return this.pedidos().filter(p => p.estado === 'pendiente').length;
  });

  ngOnInit(): void {
    if (!isPlatformBrowser(this.platformId)) return;

    // 1. Estado inicial de red
    this.isOnline.set(navigator.onLine);
    window.addEventListener('online', () => this.onNetworkChange(true));
    window.addEventListener('offline', () => this.onNetworkChange(false));

    // 2. Ejercicio 4: Carga de frases.json para verificar Runtime Caching en DevTools
    this.http.get<{ frase: string }>('/data/frases.json').subscribe({
      next: (res) => {
        console.log('Datos dinámicos cargados por la PWA:', res);
        this.fraseDinamica.set(res?.frase || 'El conocimiento es poder');
      },
      error: (err) => {
        console.error('Error al solicitar los datos:', err);
        this.fraseDinamica.set('El conocimiento es poder (Modo Offline / Caché)');
      }
    });

    // 3. Cargar catálogo de productos Backus
    this.cargarCatalogo();

    // 4. Cargar pedidos persistidos desde almacenamiento local
    this.cargarPedidosLocales();

    // 5. Verificar Service Worker y escuchar actualizaciones
    if (this.swUpdate?.isEnabled) {
      this.swActivo.set(true);
      this.swUpdate.versionUpdates.subscribe(evt => {
        if (evt.type === 'VERSION_READY') {
          this.nuevaVersionDisponible.set(true);
        }
      });
    } else if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready.then(() => {
        this.swActivo.set(true);
      });
    }
  }

  cargarCatalogo(): void {
    this.http.get<Producto[]>('/data/catalogo.json').subscribe({
      next: (data) => {
        console.log('Catálogo Backus cargado con éxito:', data);
        this.productos.set(data);
      },
      error: (err) => {
        console.warn('Error al cargar catálogo remoto, usando fallback offline:', err);
        // Fallback local por seguridad si no hay red en primera carga
        this.productos.set([
          { id: 'BK-001', nombre: 'Cerveza Cristal 650ml', marca: 'Cristal', categoria: 'Cerveza', presentacion: 'Caja x 12 botellas retornables', precio: 68.50, stock: 140, icono: '🍺', destacado: true },
          { id: 'BK-003', nombre: 'Pilsen Callao 630ml', marca: 'Pilsen', categoria: 'Cerveza', presentacion: 'Caja x 12 botellas retornables', precio: 72.00, stock: 110, icono: '🍺', destacado: true },
          { id: 'BK-005', nombre: 'Cusqueña Dorada 620ml', marca: 'Cusqueña', categoria: 'Premium', presentacion: 'Caja x 12 botellas retornables', precio: 84.00, stock: 65, icono: '👑', destacado: true },
          { id: 'BK-008', nombre: 'Agua Mineral San Mateo 600ml', marca: 'San Mateo', categoria: 'Aguas', presentacion: 'Paquete x 15 botellas', precio: 32.00, stock: 120, icono: '💧', destacado: false }
        ]);
      }
    });
  }

  // Manejo de eventos de red
  onNetworkChange(online: boolean): void {
    this.isOnline.set(online);
    if (online) {
      this.mostrarPush('Conexión Reestablecida', 'Se detectó acceso a internet. Sincronizando pedidos pendientes con el servidor Backus...');
      this.sincronizarPedidosPendientes();
    } else {
      this.mostrarPush('Modo Sin Conexión', 'Estás navegando offline. Los pedidos que registres se guardarán en tu dispositivo y se enviarán automáticamente al volver la red.');
    }
  }

  toggleSimulatedOffline(): void {
    const nuevoEstado = !this.simulatedOffline();
    this.simulatedOffline.set(nuevoEstado);
    this.onNetworkChange(!nuevoEstado);
  }

  // Operaciones del Carrito
  agregarAlCarrito(producto: Producto): void {
    const actual = [...this.carrito()];
    const index = actual.findIndex(i => i.producto.id === producto.id);
    if (index > -1) {
      actual[index].cantidad++;
    } else {
      actual.push({ producto, cantidad: 1 });
    }
    this.carrito.set(actual);
  }

  removerDelCarrito(index: number): void {
    const actual = [...this.carrito()];
    actual.splice(index, 1);
    this.carrito.set(actual);
  }

  cambiarCantidad(index: number, delta: number): void {
    const actual = [...this.carrito()];
    const nuevaCant = actual[index].cantidad + delta;
    if (nuevaCant <= 0) {
      this.removerDelCarrito(index);
    } else {
      actual[index].cantidad = nuevaCant;
      this.carrito.set(actual);
    }
  }

  // Flujo de Registro de Pedido (Offline-First con Background Sync)
  registrarPedido(): void {
    if (this.carrito().length === 0) return;

    const redDisponible = this.isOnline() && !this.simulatedOffline();
    const idPedido = 'BK-' + Math.floor(100000 + Math.random() * 900000);

    const nuevoPedido: Pedido = {
      id: idPedido,
      fecha: new Date().toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      cliente: this.nombreCliente || 'Cliente General',
      zona: this.zonaRuta || 'Ruta General',
      items: this.carrito().map(i => ({
        nombre: i.producto.nombre,
        cantidad: i.cantidad,
        subtotal: i.producto.precio * i.cantidad
      })),
      total: this.totalPrecioCarrito(),
      estado: redDisponible ? 'sincronizado' : 'pendiente'
    };

    // Guardar en estado y almacenamiento local
    const listaActualizada = [nuevoPedido, ...this.pedidos()];
    this.guardarPedidosLocales(listaActualizada);

    // Vaciar carrito y cerrar modal
    this.carrito.set([]);
    this.mostrarCarrito.set(false);

    if (redDisponible) {
      this.mostrarPush(
        '¡Pedido Confirmado!',
        `Pedido ${nuevoPedido.id} enviado y registrado en el Servidor Central Backus.`
      );
    } else {
      this.mostrarPush(
        'Pedido Guardado en Modo Offline',
        `Pedido ${nuevoPedido.id} guardado localmente (IndexedDB). Se enviará automáticamente cuando el Service Worker detecte red.`
      );
    }
  }

  // Sincronización en segundo plano (Background Sync)
  sincronizarPedidosPendientes(): void {
    const lista = [...this.pedidos()];
    let sincronizados = 0;

    const actualizada = lista.map(p => {
      if (p.estado === 'pendiente') {
        sincronizados++;
        return { ...p, estado: 'sincronizado' as const };
      }
      return p;
    });

    if (sincronizados > 0) {
      this.guardarPedidosLocales(actualizada);
      setTimeout(() => {
        this.mostrarPush(
          '¡Sincronización Exitosa!',
          `Se procesaron y despacharon ${sincronizados} pedido(s) pendientes al servidor central de Backus.`
        );
      }, 800);
    }
  }

  // Persistencia local (Simulación IndexedDB / LocalStorage)
  private cargarPedidosLocales(): void {
    try {
      const data = localStorage.getItem('backus_pwa_pedidos');
      if (data) {
        this.pedidos.set(JSON.parse(data));
      } else {
        // Pedido de ejemplo inicial
        this.pedidos.set([
          {
            id: 'BK-542190',
            fecha: '08:30:15',
            cliente: 'Bodega La Unión',
            zona: 'Ruta 14 - Lima Norte',
            items: [{ nombre: 'Cerveza Cristal 650ml', cantidad: 3, subtotal: 205.50 }],
            total: 205.50,
            estado: 'sincronizado'
          }
        ]);
      }
    } catch (e) {
      console.error('Error leyendo almacenamiento local:', e);
    }
  }

  private guardarPedidosLocales(lista: Pedido[]): void {
    this.pedidos.set(lista);
    try {
      localStorage.setItem('backus_pwa_pedidos', JSON.stringify(lista));
    } catch (e) {
      console.error('Error guardando en almacenamiento local:', e);
    }
  }

  // Notificación Push Simulado
  mostrarPush(titulo: string, mensaje: string): void {
    this.notificacionPush.set({ visible: true, titulo, mensaje });

    // Si el navegador soporta Notification API y tiene permiso:
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(titulo, {
          body: mensaje,
          icon: '/icons/icon-192x192.png'
        });
      } catch (e) {
        // Ignorar si hay restricciones de permisos
      }
    }

    setTimeout(() => {
      this.notificacionPush.update(n => ({ ...n, visible: false }));
    }, 5500);
  }

  solicitarPermisoNotificaciones(): void {
    if ('Notification' in window) {
      Notification.requestPermission().then(permission => {
        if (permission === 'granted') {
          this.mostrarPush('Notificaciones Habilitadas', 'Recibirás avisos de confirmación de despacho y sincronización.');
        }
      });
    }
  }

  actualizarPWA(): void {
    if (this.swUpdate?.isEnabled) {
      this.swUpdate.activateUpdate().then(() => document.location.reload());
    } else {
      document.location.reload();
    }
  }
}
