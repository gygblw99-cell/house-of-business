# Nginx + SSL — מדריך התקנה

## 1. בחירת דומיין לפלטפורמה
פתח את `nginx.conf` וחפש `APP_DOMAIN` — החלף בדומיין שבחרת (למשל `app.houseofbusiness.co.il`).
עדכן גם את `.env.production` של הבקאנד:
```
ALLOWED_ORIGINS=https://APP_DOMAIN
```

## 2. התקנת Nginx (על שרת Linux)
```bash
sudo apt update && sudo apt install -y nginx
sudo cp nginx.conf /etc/nginx/nginx.conf
sudo nginx -t          # בדיקת תקינות
```

## 3. הוצאת תעודת SSL עם Certbot
```bash
sudo apt install -y certbot
# תחילה בצע challenge עם nginx בלי SSL (הסר את בלוק 443 זמנית):
sudo certbot certonly --standalone -d houseofbusiness.co.il -d www.houseofbusiness.co.il
sudo certbot certonly --standalone -d APP_DOMAIN
# אחרי שהתעודות קיימות — החזר את nginx.conf המלא:
sudo nginx -s reload
```

## 4. DNS — רשומות A
בפאנל הדומיין שלך (GoDaddy / Cloudflare / וכו'):
```
A   @              → IP_של_השרת
A   www            → IP_של_השרת
A   APP_DOMAIN     → IP_של_השרת   (אם סאבדומיין)
```

## 5. עדכון ALLOWED_ORIGINS בבקאנד
בקובץ `backend/.env` (ו-`.env.production` אם קיים):
```
ALLOWED_ORIGINS=https://APP_DOMAIN
```
ואז: `pm2 restart hob-backend`

## 6. חידוש אוטומטי של תעודה
```bash
sudo crontab -e
# הוסף:
0 3 1 * * certbot renew --quiet && nginx -s reload
```
