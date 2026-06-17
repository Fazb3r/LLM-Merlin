# Usamos la imagen oficial de Node.js v20 como base
FROM node:20

# Creamos y establecemos el directorio de trabajo dentro del contenedor
WORKDIR /usr/src/app

# Copiamos los archivos de dependencias
COPY package*.json ./

# Instalamos las dependencias (compila módulos nativos como better-sqlite3)
RUN npm install

# Copiamos el resto de los archivos de la aplicación
COPY . .

# Compilamos el código TypeScript a JavaScript
RUN npm run build

# Nos aseguramos de que el directorio para la base de datos exista
RUN mkdir -p src/data

# Comando para iniciar el bot
CMD [ "npm", "start" ]
