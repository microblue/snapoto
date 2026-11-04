package com.snapoto.app;
import org.junit.Test;
import static org.junit.Assert.*;
import java.nio.file.Files;
import java.io.File;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
public class CaptureStoreTest {
 @Test public void hashDetectsAnyOriginalChange() throws Exception {
  byte[] original="original photo bytes".getBytes(StandardCharsets.UTF_8);
  String first=CaptureStore.digest(original);
  assertEquals(64,first.length());
  assertEquals(first,CaptureStore.digest(original.clone()));
  original[0]^=1;
  assertNotEquals(first,CaptureStore.digest(original));
 }
 @Test public void metadataIsDurableAndAtomic() throws Exception {
  File dir=Files.createTempDirectory("snapoto-local").toFile();
  File target=new File(dir,"capture.json");
  JSONObject record=new JSONObject().put("id","one").put("state","pending");
  CaptureStore.atomic(target,record);
  assertTrue(target.exists());
  assertFalse(new File(target.getPath()+".tmp").exists());
  JSONObject saved=new JSONObject(new String(Files.readAllBytes(target.toPath()),StandardCharsets.UTF_8));
  assertEquals("pending",saved.getString("state"));
  record.put("state","synced");CaptureStore.atomic(target,record);
  saved=new JSONObject(new String(Files.readAllBytes(target.toPath()),StandardCharsets.UTF_8));
  assertEquals("synced",saved.getString("state"));
  target.delete();dir.delete();
 }
 @Test public void storagePrecheckPassesWhenRoom() throws Exception {
  File dir=Files.createTempDirectory("snapoto-space").toFile();
  CaptureStore.requireSpace(dir,1);
  dir.delete();
 }
 @Test public void storagePrecheckFailsEnospcWhenShort() throws Exception {
  File dir=Files.createTempDirectory("snapoto-full").toFile();
  try {CaptureStore.requireSpace(dir,Long.MAX_VALUE);fail("Must throw when usable space is below the capture minimum");}catch(java.io.IOException expected){assertTrue(CaptureStore.isNoSpace(expected));}
  dir.delete();
 }
 @Test public void enospcMatchesBothSpellings() {
  assertTrue(CaptureStore.isNoSpace(new java.io.IOException("write failed: ENOSPC")));
  assertTrue(CaptureStore.isNoSpace(new java.io.IOException("No space left on device")));
  assertFalse(CaptureStore.isNoSpace(new java.io.IOException("boom")));
  assertFalse(CaptureStore.isNoSpace(null));
 }
 @Test public void failedMetadataWriteDoesNotReportSuccess() throws Exception {
  File dir=Files.createTempDirectory("snapoto-failure").toFile();
  File invalid=new File(new File(dir,"missing"),"capture.json");
  try {CaptureStore.atomic(invalid,new JSONObject().put("id","one"));fail("Must throw when local storage cannot accept a write");}catch(java.io.IOException expected){assertFalse(invalid.exists());}
  dir.delete();
 }
 @Test public void streamingDigestMatchesInMemoryDigest() throws Exception {
  File f=Files.createTempFile("snapoto-big",".bin").toFile();
  byte[] data=new byte[3*64*1024+17];new java.util.Random(7).nextBytes(data);
  Files.write(f.toPath(),data);
  assertEquals(CaptureStore.digest(data),CaptureStore.digest(f));
  f.delete();
 }
 @Test public void updateMergesWithFreshestDiskCopy() throws Exception {
  File dir=Files.createTempDirectory("snapoto-merge").toFile();
  File target=new File(dir,"c.json");
  CaptureStore.atomic(target,new JSONObject().put("id","c").put("state","processing"));
  JSONObject stale=new JSONObject(new String(Files.readAllBytes(target.toPath()),StandardCharsets.UTF_8));
  CaptureStore.update(target,r->r.put("rendered","c-rendered.jpg"));
  CaptureStore.update(target,r->r.put("state","synced"));
  JSONObject saved=new JSONObject(new String(Files.readAllBytes(target.toPath()),StandardCharsets.UTF_8));
  assertEquals("synced",saved.getString("state"));
  assertEquals("c-rendered.jpg",saved.getString("rendered"));
  assertFalse(stale.has("rendered"));
  target.delete();dir.delete();
 }
 @Test public void concurrentWritersNeverTearARecord() throws Exception {
  File dir=Files.createTempDirectory("snapoto-race").toFile();
  File target=new File(dir,"c.json");
  CaptureStore.atomic(target,new JSONObject().put("id","c").put("n",0));
  Thread[] ts=new Thread[8];
  for(int t=0;t<ts.length;t++){ts[t]=new Thread(()->{for(int i=0;i<25;i++)try{CaptureStore.update(target,r->r.put("n",r.getInt("n")+1));}catch(Exception e){throw new RuntimeException(e);}});ts[t].start();}
  for(Thread t:ts)t.join();
  JSONObject saved=new JSONObject(new String(Files.readAllBytes(target.toPath()),StandardCharsets.UTF_8));
  assertEquals(200,saved.getInt("n"));
  target.delete();dir.delete();
 }
}
