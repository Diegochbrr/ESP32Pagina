"""
HeadController — Backend API
Conecta la página web con la base de datos MySQL en Clever Cloud
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
import mysql.connector
import os
from datetime import datetime
from dotenv import load_dotenv

load_dotenv()  # Carga el archivo .env automáticamente

app = Flask(__name__)
CORS(app)  # Permite peticiones desde la página web

# ── Credenciales Clever Cloud ──────────────────
# Opción 1: Variables de entorno (recomendado)
# Opción 2: Reemplaza directamente los valores aquí
DB_CONFIG = {
    'host':     os.getenv('DB_HOST',     'TU_HOST.cleverapps.io'),
    'port':     int(os.getenv('DB_PORT', '3306')),
    'database': os.getenv('DB_NAME',     'TU_DATABASE'),
    'user':     os.getenv('DB_USER',     'TU_USUARIO'),
    'password': os.getenv('DB_PASSWORD', 'TU_PASSWORD'),
    'charset':  'utf8mb4',
    'connection_timeout': 10,
}

def get_conn():
    return mysql.connector.connect(**DB_CONFIG)

# ── Crear tabla si no existe ───────────────────
def init_db():
    try:
        conn = get_conn()
        cur  = conn.cursor()
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sesiones (
                id               INT AUTO_INCREMENT PRIMARY KEY,
                fecha_inicio     DATETIME NOT NULL,
                fecha_fin        DATETIME NOT NULL,
                duracion_seg     INT NOT NULL,
                modo             VARCHAR(10) NOT NULL COMMENT 'serial | bluetooth',
                total_comandos   INT DEFAULT 0,
                cnt_up           INT DEFAULT 0,
                cnt_down         INT DEFAULT 0,
                cnt_left         INT DEFAULT 0,
                cnt_right        INT DEFAULT 0,
                cnt_idle         INT DEFAULT 0,
                intensidad_avg   FLOAT DEFAULT 0,
                accion_dominante VARCHAR(10) DEFAULT 'IDLE',
                creado_en        DATETIME DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        """)
        conn.commit()
        cur.close()
        conn.close()
        print("✓ Base de datos lista")
    except Exception as e:
        print(f"✗ Error al inicializar DB: {e}")

# ── Rutas ──────────────────────────────────────

@app.route('/ping')
def ping():
    """Verificar que el backend y la BD están activos"""
    try:
        conn = get_conn()
        conn.close()
        return jsonify({'ok': True, 'message': 'Backend HeadController activo'})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


@app.route('/stats')
def stats():
    """Estadísticas generales"""
    try:
        conn = get_conn()
        cur  = conn.cursor(dictionary=True)

        cur.execute("SELECT COUNT(*) as total FROM sesiones")
        total = cur.fetchone()['total']

        cur.execute("SELECT MAX(fecha_inicio) as ultima FROM sesiones")
        ultima = cur.fetchone()['ultima']

        cur.execute("SELECT SUM(duracion_seg) as total_seg FROM sesiones")
        total_seg = cur.fetchone()['total_seg'] or 0

        cur.execute("SELECT AVG(intensidad_avg) as avg_int FROM sesiones")
        avg_int = cur.fetchone()['avg_int'] or 0

        cur.execute("""
            SELECT accion_dominante, COUNT(*) as veces
            FROM sesiones
            GROUP BY accion_dominante
            ORDER BY veces DESC LIMIT 1
        """)
        dom = cur.fetchone()

        cur.execute("""
            SELECT
                SUM(cnt_up)    as total_up,
                SUM(cnt_down)  as total_down,
                SUM(cnt_left)  as total_left,
                SUM(cnt_right) as total_right
            FROM sesiones
        """)
        totales = cur.fetchone()

        cur.close()
        conn.close()

        return jsonify({
            'total_sesiones':    total,
            'ultima_sesion':     ultima.isoformat() if ultima else None,
            'tiempo_total_seg':  int(total_seg),
            'intensidad_avg':    round(float(avg_int), 3),
            'accion_dominante':  dom['accion_dominante'] if dom else None,
            'total_up':          int(totales['total_up']    or 0),
            'total_down':        int(totales['total_down']  or 0),
            'total_left':        int(totales['total_left']  or 0),
            'total_right':       int(totales['total_right'] or 0),
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/sesiones', methods=['GET'])
def get_sesiones():
    """Últimas N sesiones"""
    limit = min(int(request.args.get('limit', 10)), 100)
    try:
        conn = get_conn()
        cur  = conn.cursor(dictionary=True)
        cur.execute("""
            SELECT id, fecha_inicio, fecha_fin, duracion_seg, modo,
                   total_comandos, cnt_up, cnt_down, cnt_left, cnt_right,
                   intensidad_avg, accion_dominante
            FROM sesiones
            ORDER BY fecha_inicio DESC
            LIMIT %s
        """, (limit,))
        rows = cur.fetchall()
        cur.close()
        conn.close()

        # Serializar datetimes
        for r in rows:
            r['fecha_inicio'] = r['fecha_inicio'].isoformat()
            r['fecha_fin']    = r['fecha_fin'].isoformat()

        return jsonify(rows)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/sesiones', methods=['POST'])
def save_sesion():
    """Guardar resumen de una sesión"""
    data = request.json
    if not data:
        return jsonify({'error': 'Sin datos'}), 400

    required = ['fecha_inicio', 'fecha_fin', 'duracion_seg', 'modo']
    for field in required:
        if field not in data:
            return jsonify({'error': f'Campo requerido: {field}'}), 400

    try:
        conn = get_conn()
        cur  = conn.cursor()
        cur.execute("""
            INSERT INTO sesiones
                (fecha_inicio, fecha_fin, duracion_seg, modo,
                 total_comandos, cnt_up, cnt_down, cnt_left, cnt_right, cnt_idle,
                 intensidad_avg, accion_dominante)
            VALUES
                (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """, (
            data['fecha_inicio'],
            data['fecha_fin'],
            data['duracion_seg'],
            data['modo'],
            data.get('total_comandos', 0),
            data.get('cnt_up', 0),
            data.get('cnt_down', 0),
            data.get('cnt_left', 0),
            data.get('cnt_right', 0),
            data.get('cnt_idle', 0),
            data.get('intensidad_avg', 0),
            data.get('accion_dominante', 'IDLE'),
        ))
        conn.commit()
        new_id = cur.lastrowid
        cur.close()
        conn.close()
        return jsonify({'ok': True, 'id': new_id}), 201

    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/sesiones/<int:session_id>', methods=['DELETE'])
def delete_sesion(session_id):
    """Eliminar una sesión por ID"""
    try:
        conn = get_conn()
        cur  = conn.cursor()
        cur.execute("DELETE FROM sesiones WHERE id = %s", (session_id,))
        conn.commit()
        cur.close()
        conn.close()
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── Init DB al arrancar ────────────────────────
init_db()

# ── Main ───────────────────────────────────────
if __name__ == '__main__':
    port = int(os.getenv('PORT', 5000))
    print(f"\nHeadController Backend iniciado en puerto {port}\n")
    app.run(host='0.0.0.0', port=port, debug=False)