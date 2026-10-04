module rv32i_core_tb;
  logic clk = 1'b0;
  logic reset_n = 1'b0;
  logic [31:0] instr_addr;
  logic [31:0] instr_rdata;
  logic data_req;
  logic data_we;
  logic [3:0] data_wstrb;
  logic [31:0] data_addr;
  logic [31:0] data_wdata;
  logic [31:0] data_rdata;
  logic [31:0] imem [0:255];
  logic [31:0] dmem [0:255];
  logic srai_seen = 1'b0;
  logic andi_seen = 1'b0;
  logic lui_seen = 1'b0;
  logic auipc_seen = 1'b0;
  integer lane;
  integer cycles;

  always #5 clk = ~clk;
  assign instr_rdata = imem[instr_addr[9:2]];
  assign data_rdata = dmem[data_addr[9:2]];

  rv32i_core dut (
    .clk_i(clk),
    .reset_ni(reset_n),
    .instr_addr_o(instr_addr),
    .instr_rdata_i(instr_rdata),
    .data_req_o(data_req),
    .data_we_o(data_we),
    .data_wstrb_o(data_wstrb),
    .data_addr_o(data_addr),
    .data_wdata_o(data_wdata),
    .data_rdata_i(data_rdata)
  );

  function automatic [31:0] enc_i(
    input integer imm,
    input integer rs1,
    input integer funct3,
    input integer rd,
    input integer opcode
  );
    enc_i = {imm[11:0], rs1[4:0], funct3[2:0], rd[4:0], opcode[6:0]};
  endfunction

  function automatic [31:0] enc_r(
    input integer funct7,
    input integer rs2,
    input integer rs1,
    input integer funct3,
    input integer rd,
    input integer opcode
  );
    enc_r = {funct7[6:0], rs2[4:0], rs1[4:0], funct3[2:0], rd[4:0], opcode[6:0]};
  endfunction

  function automatic [31:0] enc_s(
    input integer imm,
    input integer rs2,
    input integer rs1,
    input integer funct3
  );
    enc_s = {imm[11:5], rs2[4:0], rs1[4:0], funct3[2:0], imm[4:0], 7'b0100011};
  endfunction

  function automatic [31:0] enc_b(
    input integer imm,
    input integer rs2,
    input integer rs1,
    input integer funct3
  );
    enc_b = {imm[12], imm[10:5], rs2[4:0], rs1[4:0], funct3[2:0],
             imm[4:1], imm[11], 7'b1100011};
  endfunction

  function automatic [31:0] enc_u(input integer imm, input integer rd);
    enc_u = {imm[19:0], rd[4:0], 7'b0110111};
  endfunction

  function automatic [31:0] enc_j(input integer imm, input integer rd);
    enc_j = {imm[20], imm[10:1], imm[11], imm[19:12], rd[4:0], 7'b1101111};
  endfunction

  always @(posedge clk) begin
    if (reset_n && dut.registers[9] === 32'hffff_ffff) srai_seen <= 1'b1;
    if (reset_n && dut.registers[10] === 32'd255) andi_seen <= 1'b1;
    if (reset_n && dut.registers[11] === 32'h1234_5000) lui_seen <= 1'b1;
    if (reset_n && dut.registers[12] === 32'h0000_103c) auipc_seen <= 1'b1;
    if (reset_n && data_req && data_we) begin
      for (lane = 0; lane < 4; lane = lane + 1)
        if (data_wstrb[lane])
          dmem[data_addr[9:2]][lane*8 +: 8] <= data_wdata[lane*8 +: 8];
    end
  end

  initial begin
    for (integer i = 0; i < 256; i = i + 1) begin
      imem[i] = 32'h0000_0013;
      dmem[i] = 32'b0;
    end

    imem[0]  = enc_i(5,   0, 0,  1, 7'b0010011);
    imem[1]  = enc_i(7,   1, 0,  2, 7'b0010011);
    imem[2]  = enc_r(0,   2, 1,  0,  3, 7'b0110011);
    imem[3]  = enc_s(0,   3, 0,  2);
    imem[4]  = enc_i(0,   0, 2,  4, 7'b0000011);
    imem[5]  = enc_i(1,   4, 0,  5, 7'b0010011);
    imem[6]  = enc_i(18,  0, 0,  6, 7'b0010011);
    imem[7]  = enc_b(8,   6, 5,  0);
    imem[8]  = enc_i(99,  0, 0,  7, 7'b0010011);
    imem[9]  = enc_i(42,  0, 0,  7, 7'b0010011);
    imem[10] = enc_s(4,   7, 0,  2);
    imem[11] = enc_i(-1,  0, 0,  8, 7'b0010011);
    imem[12] = enc_i(1,   8, 5,  9, 7'b0010011);
    imem[12][31:25] = 7'b0100000;
    imem[13] = enc_i(255, 9, 7, 10, 7'b0010011);
    imem[14] = enc_u(20'h12345, 11);
    imem[15] = {20'h00001, 5'd12, 7'b0010111};
    imem[16] = enc_j(8, 13);
    imem[17] = enc_i(99,  0, 0, 14, 7'b0010011);
    imem[18] = enc_i(7,   0, 0, 14, 7'b0010011);
    imem[19] = enc_i(84,  0, 0, 15, 7'b0010011);
    imem[20] = enc_i(0,  15, 0, 16, 7'b1100111);
    imem[21] = enc_i(99,  0, 0, 17, 7'b0010011);
    imem[22] = enc_i(9,   0, 0, 17, 7'b0010011);
    imem[23] = enc_s(8,   8, 0,  0);
    imem[24] = enc_i(8,   0, 0, 18, 7'b0000011);
    imem[25] = enc_i(8,   0, 4, 19, 7'b0000011);
    imem[26] = enc_s(10,  2, 0,  1);
    imem[27] = enc_i(10,  0, 1, 20, 7'b0000011);
    imem[28] = enc_b(8,   1, 8,  4);
    imem[29] = enc_i(99,  0, 0, 17, 7'b0010011);
    imem[30] = enc_b(8,  19, 18, 7);
    imem[31] = enc_i(99,  0, 0, 18, 7'b0010011);
    imem[32] = enc_r(7'b0100000, 1, 2, 0, 24, 7'b0110011);
    imem[33] = enc_r(0, 2, 1, 1, 25, 7'b0110011);
    imem[34] = enc_r(0, 1, 8, 2, 26, 7'b0110011);
    imem[35] = enc_r(0, 1, 8, 3, 27, 7'b0110011);
    imem[36] = enc_r(0, 2, 3, 4, 28, 7'b0110011);
    imem[37] = enc_r(0, 1, 3, 5, 29, 7'b0110011);
    imem[38] = enc_r(0, 2, 1, 6, 30, 7'b0110011);
    imem[39] = enc_r(0, 2, 1, 7, 31, 7'b0110011);
    imem[40] = enc_i(0, 8, 2, 22, 7'b0010011);
    imem[41] = enc_i(1, 8, 3, 23, 7'b0010011);
    imem[42] = enc_i(2, 1, 1, 9, 7'b0010011);
    imem[43] = enc_i(1, 3, 5, 10, 7'b0010011);
    imem[43][31:25] = 7'b0000000;
    imem[44] = enc_i(3, 1, 4, 11, 7'b0010011);
    imem[45] = enc_i(8, 1, 6, 12, 7'b0010011);
    imem[46] = enc_b(8, 2, 1, 1);
    imem[47] = enc_i(99, 0, 0, 14, 7'b0010011);
    imem[48] = enc_i(85, 0, 0, 21, 7'b0010011);
    imem[49] = enc_s(16, 21, 0, 2);
    imem[50] = enc_j(0, 0);

    repeat (4) @(posedge clk);
    reset_n = 1'b1;
    cycles = 0;
    while (dmem[4] !== 32'd85 && cycles < 500) begin
      @(posedge clk);
      cycles = cycles + 1;
    end
    if (cycles >= 500) $fatal(1, "processor timed out waiting for completion store");
    repeat (4) @(posedge clk);

    if (dut.registers[0] !== 32'd0) $fatal(1, "x0 changed");
    if (dut.registers[1] !== 32'd5) $fatal(1, "ADDI result x1=%h", dut.registers[1]);
    if (dut.registers[2] !== 32'd12) $fatal(1, "forwarded ADDI result x2=%h", dut.registers[2]);
    if (dut.registers[3] !== 32'd17 || dmem[0] !== 32'd17) $fatal(1, "forwarded ADD/SW failed");
    if (dut.registers[4] !== 32'd17) $fatal(1, "LW result x4=%h", dut.registers[4]);
    if (dut.registers[5] !== 32'd18) $fatal(1, "load-use stall failed x5=%h", dut.registers[5]);
    if (dut.registers[7] !== 32'd42 || dmem[1] !== 32'd42) $fatal(1, "taken BEQ failed to flush wrong path");
    if (!srai_seen) $fatal(1, "SRAI failed");
    if (!andi_seen || !lui_seen || !auipc_seen) $fatal(1, "ANDI/LUI/AUIPC failed");
    if (dut.registers[13] !== 32'd68 || dut.registers[14] !== 32'd7) $fatal(1, "JAL/link or BNE flush failed");
    if (dut.registers[16] !== 32'd84 || dut.registers[17] !== 32'd9) $fatal(1, "JALR/link or BLT flush failed");
    if (dut.registers[18] !== 32'hffff_ffff || dut.registers[19] !== 32'd255) $fatal(1, "LB/LBU or BGEU flush failed");
    if (dut.registers[20] !== 32'd12 || dmem[2] !== 32'h000c_00ff) $fatal(1, "SH/LH byte lanes failed");
    if (dut.registers[23] !== 32'd0) $fatal(1, "taken BLT failed to flush");
    if (dut.registers[24] !== 32'd7 || dut.registers[25] !== 32'd20480) $fatal(1, "SUB/SLL failed");
    if (dut.registers[26] !== 32'd1 || dut.registers[27] !== 32'd0) $fatal(1, "SLT/SLTU failed");
    if (dut.registers[28] !== 32'd29 || dut.registers[29] !== 32'd0) $fatal(1, "XOR/SRL failed");
    if (dut.registers[30] !== 32'd13 || dut.registers[31] !== 32'd4) $fatal(1, "OR/AND failed");
    if (dut.registers[9] !== 32'd20 || dut.registers[10] !== 32'd8) $fatal(1, "SLLI/SRLI failed");
    if (dut.registers[11] !== 32'd6 || dut.registers[12] !== 32'd13) $fatal(1, "XORI/ORI failed");
    if (dut.registers[22] !== 32'd1) $fatal(1, "SLTI failed");
    $display("RV32I_PIPELINE_PASS cycles=%0d", cycles);
    $finish;
  end
endmodule
