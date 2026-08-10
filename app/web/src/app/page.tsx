import Link from "next/link";
import { incident } from "@/lib/incident";

export default function Home() {
  return (
    <div className="wrap">
      <div className="hero">
        <span className="pill">
          Incidente activo · {incident.id}
        </span>
        <h1>
          De 50.000 reportes dispersos
          <br />a un mapa que dice dónde cavar.
        </h1>
        <p className="lead">
          Rescue Heatmap recoge reportes de personas desaparecidas desde cualquier canal —web, WhatsApp,
          SMS, papel o un nodo local sin internet— los deduplica <em>al momento de entrar</em>, y los
          convierte en un mapa de calor priorizado para los equipos de búsqueda y rescate.
        </p>
        <div className="row" style={{ marginTop: 24 }}>
          <Link className="btn primary" href="/reportar">
            Reportar una persona
          </Link>
          <Link className="btn" href="/panel">
            Ver el panel de mando
          </Link>
          <Link className="btn ghost" href="/buscar">
            Buscar en la lista
          </Link>
        </div>
      </div>

      <div className="section-title">El producto, en tres pantallas</div>
      <div className="grid cols-3">
        <div className="card">
          <h3>1 · Formulario ciudadano</h3>
          <p>
            Menos de 90 segundos. Solo dos campos obligatorios: quién y dónde. Guarda primero en el
            teléfono y transmite después, con estado honesto: <em>&quot;guardado, aún no enviado&quot;</em>.
            Siempre devuelve un número de referencia, incluso sin señal.
          </p>
        </div>
        <div className="card">
          <h3>2 · Panel de mando</h3>
          <p>
            Mapa de calor ponderado por precisión de ubicación, urgencia (atrapado con vida pesa 2,5×) y
            corroboración (30 familiares señalando el mismo edificio es señal, no ruido). Exportable a
            CSV/KML para los equipos INSARAG.
          </p>
        </div>
        <div className="card">
          <h3>3 · App de terreno</h3>
          <p>
            Para el equipo en el escombro: funciona sin red, sincroniza cuando vuelve, y sus estados
            verificados <strong>sobrescriben siempre</strong> el reporte ciudadano.
          </p>
        </div>
      </div>

      <div className="section-title">Lo que aprendimos de Venezuela (y no vamos a repetir)</div>
      <div className="grid cols-3">
        <div className="card">
          <h3>~24% de duplicados</h3>
          <p>
            Diez personas reportando al mismo desaparecido. Aquí la deduplicación ocurre <em>en la entrada</em>:
            si hay coincidencia, se le pregunta a quien reporta. Nunca se rechaza ni se fusiona en silencio.
          </p>
        </div>
        <div className="card">
          <h3>Registros congelados</h3>
          <p>
            Miles de fichas en &quot;se busca&quot; para siempre. Aquí cada reporte recibe un recordatorio a las
            72 horas y un camino de un toque para decir &quot;apareció&quot;.
          </p>
        </div>
        <div className="card">
          <h3>Una lista plana, sin mapa</h3>
          <p>
            La información existía pero no era <em>accionable</em>. La geolocalización con nivel de
            precisión declarado es lo que convierte datos en una prioridad de excavación.
          </p>
        </div>
      </div>

      <div className="section-title">Conectividad: no es &quot;hay internet o no hay&quot;</div>
      <div className="card">
        <p style={{ color: "var(--text)" }}>
          Tras un sismo la cobertura es <strong>irregular</strong>: antenas saturadas, cortes de energía que
          las van apagando, un barrio con señal y el de al lado sin nada, y SMS que sobrevive cuando los
          datos ya no. Por eso el producto es una cascada de respaldos:
        </p>
        <ul className="muted" style={{ lineHeight: 1.9, marginBottom: 0 }}>
          <li>Con internet → formulario normal</li>
          <li>Internet malo → PWA con cola local y botón manual de &quot;enviar ahora&quot;</li>
          <li>Sin internet, con punto de ayuda cerca → <strong>Rescue Node</strong>: wifi local + portal cautivo</li>
          <li>Sin datos pero con señal → plantilla por SMS</li>
          <li>Sin nada → papel + digitalización centralizada</li>
        </ul>
      </div>

      <p className="small muted" style={{ marginTop: 32 }}>
        Código abierto · MIT ·{" "}
        <a href="https://github.com/nitzanmr/rescue-heatmap" style={{ textDecoration: "underline" }}>
          github.com/nitzanmr/rescue-heatmap
        </a>
      </p>
    </div>
  );
}
